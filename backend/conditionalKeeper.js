/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║   AURA CONDITIONAL ORDER KEEPER                                   ║
 * ║   Monitors Pyth prices → executes SL/TP on AuraPerps             ║
 * ║   + ConditionalOrderManager on Robinhood Chain                    ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Two execution paths:
 *   1. AuraPerps.executeTriggerOrder — for positions with on-chain triggers
 *   2. ConditionalOrderManager.executeOrder — for keeper-managed orders
 *
 * Run:  node conditionalKeeper.js
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: true });
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { computeHealth, recommendTopUp } = require("./healthFactor");

// ── Config ──
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ROBINHOOD_RPC = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const AURA_PERPS_ADDRESS = process.env.AURA_PERPS_ADDRESS;
const COM_ADDRESS = process.env.CONDITIONAL_ORDER_MANAGER_ADDRESS;
const SHIELD_ADDRESS = process.env.LIQUIDATION_SHIELD_ADDRESS;
const ORACLE_ADDRESS = process.env.MOCK_ORACLE_ADDRESS || "0x097AeB196366317cf97986A04f32Df312c96ABa1";
const INTERVAL_MS = parseInt(process.env.COND_KEEPER_INTERVAL_MS || "10000");
const ASSETS = (process.env.KEEPER_ASSETS || "BTC,ETH").split(",").map(s => s.trim().toUpperCase());

// Liquidation alerts log (consumed by /api/liquidation-alerts SSE endpoint)
const LIQUIDATION_LOG = path.join(__dirname, "liquidation-events.json");

// Cooldown to avoid spamming alerts for the same position (60s)
const ALERT_COOLDOWN_MS = 60_000;
const recentAlerts = new Map(); // positionId → timestamp

function logLiquidationAlert(event) {
    let events = [];
    try {
        if (fs.existsSync(LIQUIDATION_LOG)) {
            events = JSON.parse(fs.readFileSync(LIQUIDATION_LOG, "utf8"));
        }
    } catch {}
    events.push({ ...event, timestamp: Date.now() });
    if (events.length > 100) events = events.slice(-100);
    fs.writeFileSync(LIQUIDATION_LOG, JSON.stringify(events));
}

// ── Pyth Hermes price IDs ──
const PYTH_IDS = {
    BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    AMZN: "a5ab5be0e4e1a1e9c35a0e76956b89b7b4a6deb3c3e4e5f6a7b8c9d0e1f2a3b4",
};

// ── ABIs ──
const PERPS_ABI = [
    "function nextPositionId() view returns (uint256)",
    "function positions(uint256) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
    "function executeTriggerOrder(uint256 positionId)",
];

const COM_ABI = [
    "function nextOrderId() view returns (uint256)",
    "function getExecutableOrders(string asset, uint256 maxResults) view returns (uint256[])",
    "function executeOrder(uint256 orderId)",
    "function orders(uint256) view returns (address owner, uint256 positionId, string asset, uint8 orderType, uint256 triggerPrice, uint8 status, uint256 createdAt, uint256 executedAt)",
];

const SHIELD_ABI = [
    "function mandates(uint256) view returns (bool armed, uint256 thresholdBps, uint256 recommendedTopUp, uint256 maxTopUpPerEvent, uint256 createdAt, uint256 updatedAt)",
    "function recordAlert(uint256 positionId, uint256 healthBps)",
];

const ORACLE_ABI = [
    "function setPrice(string asset, uint256 price) external",
    "function getPrice(string asset) view returns (uint256)",
];

let provider, wallet, perps, com, shield, oracle;

async function fetchPythPrices() {
    const ids = ASSETS.map(a => PYTH_IDS[a]).filter(Boolean);
    if (ids.length === 0) return {};
    const url = `https://hermes.pyth.network/v2/updates/price/latest?` + ids.map(id => `ids[]=${id}`).join("&");
    try {
        const res = await fetch(url);
        const data = await res.json();
        const out = {};
        for (const entry of data.parsed || []) {
            const px = Number(entry.price.price) * Math.pow(10, entry.price.expo);
            for (const [sym, pythId] of Object.entries(PYTH_IDS)) {
                if (entry.id.toLowerCase() === pythId.toLowerCase()) {
                    out[sym] = px;
                }
            }
        }
        return out;
    } catch (e) {
        console.error("[CondKeeper] Pyth fetch error:", e.message);
        return {};
    }
}

/// Path 1: Scan AuraPerps positions with on-chain triggers and execute them
async function scanPerpsTriggersForAsset(asset, currentPrice) {
    if (!perps) return;

    const nextId = Number(await perps.nextPositionId());
    const priceWei = ethers.parseUnits(currentPrice.toFixed(2), 18);

    // Oracle is now updated globally by liquidator.js heartbeat, no need to do it here

    // Scan last 50 positions (bounded for gas/time)
    const start = Math.max(0, nextId - 50);
    let executed = 0;

    for (let i = start; i < nextId; i++) {
        try {
            const pos = await perps.positions(i);
            if (!pos.isOpen) continue;
            if (pos.asset !== asset) continue;
            if (pos.takeProfitPrice === 0n && pos.stopLossPrice === 0n) continue;

            // Check if trigger is met
            let shouldExecute = false;
            if (pos.isLong) {
                if (pos.takeProfitPrice > 0n && priceWei >= pos.takeProfitPrice) shouldExecute = true;
                if (pos.stopLossPrice > 0n && priceWei <= pos.stopLossPrice) shouldExecute = true;
            } else {
                if (pos.takeProfitPrice > 0n && priceWei <= pos.takeProfitPrice) shouldExecute = true;
                if (pos.stopLossPrice > 0n && priceWei >= pos.stopLossPrice) shouldExecute = true;
            }

            if (shouldExecute) {
                console.log(`[CondKeeper]  Trigger hit! Position #${i} (${pos.isLong ? "LONG" : "SHORT"} ${asset}) @ $${currentPrice.toFixed(2)}`);
                const tx = await perps.executeTriggerOrder(i);
                await tx.wait();
                console.log(`[CondKeeper]  Position #${i} closed via trigger | tx: ${tx.hash}`);
                executed++;
            }
        } catch (e) {
            // Skip positions that fail (already closed, etc.)
            if (!e.message?.includes("Triggers not met") && !e.message?.includes("Position not open")) {
                console.warn(`[CondKeeper] Position #${i} check failed:`, e.shortMessage || e.message);
            }
        }
    }

    if (executed > 0) {
        console.log(`[CondKeeper]  Executed ${executed} trigger(s) for ${asset}`);
    }
}

/// Path 2: Scan ConditionalOrderManager for executable orders
async function scanConditionalOrders(asset) {
    if (!com) return;

    try {
        const executable = await com.getExecutableOrders(asset, 20);
        if (executable.length === 0) return;

        console.log(`[CondKeeper]  ${executable.length} conditional order(s) ready for ${asset}`);

        for (const orderId of executable) {
            try {
                const tx = await com.executeOrder(orderId);
                await tx.wait();
                console.log(`[CondKeeper]  Conditional order #${orderId} executed | tx: ${tx.hash}`);
            } catch (e) {
                console.warn(`[CondKeeper] Order #${orderId} execution failed:`, e.shortMessage || e.message);
            }
        }
    } catch (e) {
        // COM might not be deployed yet
        if (!e.message?.includes("call revert")) {
            console.warn(`[CondKeeper] COM scan failed for ${asset}:`, e.shortMessage || e.message);
        }
    }
}

/// Path 3: Liquidation Shield — scan armed positions, alert on health breach
async function scanLiquidationRisk(asset, currentPrice) {
    if (!shield) return;

    const nextId = Number(await perps.nextPositionId());
    const start = Math.max(0, nextId - 50);
    const priceWei = ethers.parseUnits(currentPrice.toFixed(2), 18);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    for (let i = start; i < nextId; i++) {
        try {
            const pos = await perps.positions(i);
            if (!pos.isOpen) continue;
            if (pos.asset !== asset) continue;

            // Check if shield is armed for this position
            const m = await shield.mandates(i);
            if (!m.armed) continue;

            // Compute health
            const { healthBps, isProfit, pnlWei, fundingFeeWei } = computeHealth({
                isLong: pos.isLong,
                collateralAmount: pos.collateralAmount,
                entryPrice: pos.entryPrice,
                positionSize: pos.positionSize,
                openedAt: pos.openedAt,
            }, priceWei, nowSeconds);

            // Below threshold? Alert.
            if (healthBps < Number(m.thresholdBps)) {
                const last = recentAlerts.get(i) || 0;
                if (Date.now() - last < ALERT_COOLDOWN_MS) continue;
                recentAlerts.set(i, Date.now());

                console.log(
                    `[Shield]  Position #${i} (${pos.isLong ? "LONG" : "SHORT"} ${asset} ${pos.leverage}x) ` +
                    `health=${(healthBps/100).toFixed(1)}% < ${(Number(m.thresholdBps)/100).toFixed(1)}% | ` +
                    `recommendedTopUp=${ethers.formatUnits(m.recommendedTopUp, 18)} aUSD`
                );

                // Push to SSE log
                logLiquidationAlert({
                    positionId: i,
                    owner: pos.owner,
                    asset: pos.asset,
                    isLong: pos.isLong,
                    leverage: Number(pos.leverage),
                    collateral: ethers.formatUnits(pos.collateralAmount, 18),
                    entryPrice: ethers.formatUnits(pos.entryPrice, 18),
                    currentPrice: currentPrice,
                    healthBps,
                    healthPct: healthBps / 100,
                    thresholdBps: Number(m.thresholdBps),
                    recommendedTopUp: ethers.formatUnits(m.recommendedTopUp, 18),
                    maxTopUpPerEvent: ethers.formatUnits(m.maxTopUpPerEvent, 18),
                    pnl: ethers.formatUnits(pnlWei, 18),
                    isProfit,
                    fundingFee: ethers.formatUnits(fundingFeeWei, 18),
                });

                // Record on-chain (auditability)
                try {
                    const tx = await shield.recordAlert(i, healthBps);
                    await tx.wait();
                    console.log(`[Shield]  Alert recorded on-chain (tx: ${tx.hash.slice(0, 10)}...)`);
                } catch (e) {
                    console.warn(`[Shield] On-chain recordAlert failed for #${i}:`, e.shortMessage || e.message);
                }
            }
        } catch (e) {
            if (!e.message?.includes("call revert")) {
                console.warn(`[Shield] Health check failed for #${i}:`, e.shortMessage || e.message);
            }
        }
    }
}

async function cycle() {
    const prices = await fetchPythPrices();
    if (Object.keys(prices).length === 0) {
        console.warn("[CondKeeper] No Pyth prices, skipping cycle.");
        return;
    }

    for (const asset of ASSETS) {
        const price = prices[asset];
        if (!price) continue;

        await scanPerpsTriggersForAsset(asset, price);
        await scanConditionalOrders(asset);
        await scanLiquidationRisk(asset, price);
    }
}

async function main() {
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║   AURA CONDITIONAL ORDER KEEPER                    ║");
    console.log("║   SL/TP Monitor → Robinhood Chain                  ║");
    console.log("╚═══════════════════════════════════════════════════╝");

    if (!PRIVATE_KEY) { console.error("Missing PRIVATE_KEY."); process.exit(1); }
    if (!AURA_PERPS_ADDRESS) { console.error("Missing AURA_PERPS_ADDRESS."); process.exit(1); }

    provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, wallet);
    oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);

    if (COM_ADDRESS) {
        com = new ethers.Contract(COM_ADDRESS, COM_ABI, wallet);
        console.log(`COM:           ${COM_ADDRESS}`);
    } else {
        console.log("COM:           Not configured (using AuraPerps triggers only)");
    }

    if (SHIELD_ADDRESS) {
        shield = new ethers.Contract(SHIELD_ADDRESS, SHIELD_ABI, wallet);
        console.log(`Shield:        ${SHIELD_ADDRESS}`);
    } else {
        console.log("Shield:        Not configured (liquidation monitoring disabled)");
    }

    const bal = await provider.getBalance(wallet.address);
    console.log(`Keeper EOA:    ${wallet.address}`);
    console.log(`AuraPerps:     ${AURA_PERPS_ADDRESS}`);
    console.log(`Balance:       ${ethers.formatEther(bal)} ETH`);
    console.log(`Assets:        ${ASSETS.join(", ")}`);
    console.log(`Cycle every:   ${INTERVAL_MS / 1000}s\n`);

    await cycle();
    setInterval(cycle, INTERVAL_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });
