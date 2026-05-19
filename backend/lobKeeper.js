/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║         AURA LOB KEEPER — Direct Stylus LOB matcher              ║
 * ║   Polls Pyth, calls match_orders(asset_hash, price) directly     ║
 * ║   on the Stylus WASM order book (Arbitrum Sepolia).              ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Architecture (post Wave-4 recadrage):
 *   - The Stylus LOB lives on Arbitrum Sepolia (chain 421614). It was
 *     initialized with the deployer EOA as router AND keeper, so this
 *     script using the same PRIVATE_KEY can call match_orders() directly.
 *   - Pyth Hermes provides off-chain prices; we feed the latest mid into
 *     `match_orders(asset_hash, current_price)` and the WASM contract flips
 *     every ACTIVE order whose limit triggers (long: price <= limit;
 *     short: price >= limit) into FILLED state.
 *   - No oracle.setPrice() needed — the Stylus contract takes the price
 *     as a per-call parameter, off-chain freshness is enforced by the keeper.
 *
 * Run:
 *   node lobKeeper.js
 *
 * Env (read from backend/.env):
 *   - PRIVATE_KEY               (must match the Stylus LOB keeper EOA)
 *   - STYLUS_LOB_ADDRESS        (default: deployed v2 address)
 *   - ARB_SEPOLIA_RPC           (optional override)
 *   - KEEPER_INTERVAL_MS        (default 10000)
 *   - KEEPER_ASSETS             (default "BTC,ETH")
 *   - KEEPER_MIN_ACTIVE         (default 1, skip match_orders if total active < this)
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: true });
const { ethers } = require("ethers");

// ── Config ──
const PRIVATE_KEY        = process.env.PRIVATE_KEY;
const STYLUS_LOB_ADDRESS = process.env.STYLUS_LOB_ADDRESS;
const ARB_SEPOLIA_RPC    = process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const ROBINHOOD_RPC      = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const INTERVAL_MS        = parseInt(process.env.KEEPER_INTERVAL_MS || "10000");
const ASSETS             = (process.env.KEEPER_ASSETS || "BTC,ETH").split(",").map(s => s.trim().toUpperCase());
const MIN_ACTIVE         = parseInt(process.env.KEEPER_MIN_ACTIVE || "1");

// Cross-chain settlement config
const AURA_PERPS_ADDRESS = process.env.AURA_PERPS_ADDRESS;
const AUSD_ADDRESS       = process.env.AUSD_ADDRESS;
const ENABLE_SETTLEMENT  = process.env.KEEPER_ENABLE_SETTLEMENT !== "0"; // default ON

// ── Stylus LOB ABI (snake_case selectors) ──
const STYLUS_LOB_ABI = [
    "function match_orders(uint256 asset_hash, uint256 current_price) returns (uint256)",
    "function get_book_depth(uint256 asset_hash) view returns (uint256, uint256)",
    "function get_stats() view returns (uint256, uint256, uint256)",
    "function get_filled_orders(uint256 asset_hash) view returns (uint256[])",
    "function get_order(uint256 order_id) view returns (address, uint256, bool, uint256, uint256, uint256, uint256, uint256)",
    "function mark_executed(uint256 order_id) returns (bool)",
];

// ── AuraPerps ABI (Robinhood Chain) ──
const PERPS_ABI = [
    "function openPosition(string asset, bool isLong, uint256 collateralAmount, uint256 leverage) returns (uint256)",
];
const AUSD_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
];
const ORACLE_ABI = [
    "function setPrice(string asset, uint256 price) external",
];

// ── Pyth Hermes price IDs (testnet-reliable) ──
const PYTH_IDS = {
    BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

let sepoliaProvider, robinhoodProvider, sepoliaWallet, robinhoodWallet, lob, perps, ausd, oracle;

// Asset symbol → hash (same convention as everywhere else)
function assetHash(symbol) {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(symbol.toUpperCase())));
}

// Reverse lookup: hash → symbol (for settlement)
const HASH_TO_SYMBOL = {};
function initHashMap() {
    for (const sym of ASSETS) {
        HASH_TO_SYMBOL[assetHash(sym).toString()] = sym;
    }
}

async function fetchPythMids() {
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
        console.error("[Keeper] Pyth fetch error:", e.message);
        return {};
    }
}

/// Cross-chain settlement: for each filled order on Stylus LOB,
/// open the corresponding position on AuraPerps (Robinhood Chain).
async function settleFilledOrders(symbol, midPrice) {
    if (!ENABLE_SETTLEMENT || !perps) return;

    const hash = assetHash(symbol);
    let filledIds;
    try {
        filledIds = await lob.get_filled_orders(hash);
    } catch (e) {
        return; // no fills or call failed
    }
    if (filledIds.length === 0) return;

    console.log(`[Keeper] 🌉 ${filledIds.length} filled order(s) for ${symbol} — settling on Robinhood Chain...`);

    // Update oracle on Robinhood Chain with fresh Pyth price before opening positions
    try {
        const priceWei = ethers.parseUnits(midPrice.toFixed(2), 18);
        await (await oracle.setPrice(symbol, priceWei)).wait();
    } catch (e) {
        console.warn(`[Keeper] Oracle update failed for ${symbol}:`, e.shortMessage || e.message);
    }

    for (const orderId of filledIds) {
        try {
            // Read order details from Stylus LOB
            const order = await lob.get_order(orderId);
            const [owner, , isLong, collateral, leverage, limitPrice, ,] = order;

            // Open position on Robinhood Chain (keeper advances the aUSD)
            const collatNum = collateral;
            
            // Ensure approval
            const allowance = await ausd.allowance(robinhoodWallet.address, AURA_PERPS_ADDRESS);
            if (allowance < collatNum) {
                const MAX = ethers.MaxUint256;
                await (await ausd.approve(AURA_PERPS_ADDRESS, MAX)).wait();
                console.log(`[Keeper] ✅ aUSD approved for AuraPerps (unlimited)`);
            }

            // Open position (keeper is msg.sender, position owned by keeper for now)
            // In production this would use openPositionFor via the router with escrow
            const tx = await perps.openPosition(symbol, isLong, collatNum, leverage);
            const receipt = await tx.wait();
            console.log(
                `[Keeper] ✅ Position opened on Robinhood Chain for order #${orderId} | ${isLong ? "LONG" : "SHORT"} ${symbol} ${leverage}x | tx ${receipt.hash}`
            );

            // Mark as executed on Stylus LOB
            await (await lob.mark_executed(orderId)).wait();
            console.log(`[Keeper] ✅ Order #${orderId} marked EXECUTED on Stylus LOB`);
        } catch (e) {
            console.error(`[Keeper] Settlement failed for order #${orderId}:`, e.shortMessage || e.message);
        }
    }
}

async function tickAsset(symbol, midPrice) {
    const hash = assetHash(symbol);
    const [bids, asks] = await lob.get_book_depth(hash);
    const totalActive = Number(bids) + Number(asks);

    if (totalActive < MIN_ACTIVE) return;

    const priceWei = ethers.parseUnits(midPrice.toFixed(2), 18);
    try {
        const tx = await lob.match_orders(hash, priceWei);
        const receipt = await tx.wait();
        console.log(
            `[Keeper] 🔨 match_orders(${symbol}, $${midPrice.toFixed(2)}) | book: bids=${bids}/asks=${asks} | tx ${receipt.hash} | gas ${receipt.gasUsed}`
        );

        // Cross-chain settlement: open positions on Robinhood for filled orders
        await settleFilledOrders(symbol, midPrice);
    } catch (e) {
        console.error(`[Keeper] match_orders(${symbol}) failed:`, e.shortMessage || e.message);
    }
}

async function cycle() {
    const mids = await fetchPythMids();
    if (Object.keys(mids).length === 0) {
        console.warn("[Keeper] No Pyth prices, skipping cycle.");
        return;
    }

    for (const symbol of ASSETS) {
        const mid = mids[symbol];
        if (!mid) continue;
        await tickAsset(symbol, mid);
    }

    try {
        const stats = await lob.get_stats();
        console.log(`[Keeper] 📈 LOB stats: nextId=${stats[0]} placed=${stats[1]} filled=${stats[2]}`);
    } catch {}
}

async function main() {
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║   AURA LOB KEEPER — Stylus / Arb Sepolia          ║");
    console.log("║   + Cross-Chain Settlement → Robinhood Chain       ║");
    console.log("╚═══════════════════════════════════════════════════╝");

    if (!PRIVATE_KEY) {
        console.error("Missing PRIVATE_KEY. Aborting.");
        process.exit(1);
    }
    if (!STYLUS_LOB_ADDRESS) {
        console.error("Missing STYLUS_LOB_ADDRESS. Aborting.");
        process.exit(1);
    }

    // ── Arbitrum Sepolia (Stylus LOB) ──
    sepoliaProvider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
    sepoliaWallet   = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);
    lob             = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, sepoliaWallet);

    // ── Robinhood Chain (AuraPerps settlement) ──
    robinhoodProvider = new ethers.JsonRpcProvider(ROBINHOOD_RPC);
    robinhoodWallet   = new ethers.Wallet(PRIVATE_KEY, robinhoodProvider);

    if (ENABLE_SETTLEMENT && AURA_PERPS_ADDRESS && AUSD_ADDRESS) {
        perps  = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodWallet);
        ausd   = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, robinhoodWallet);
        oracle = new ethers.Contract(
            process.env.MOCK_ORACLE_ADDRESS || "0x097AeB196366317cf97986A04f32Df312c96ABa1",
            ORACLE_ABI, robinhoodWallet
        );
    }

    initHashMap();

    const sepoliaBal = await sepoliaProvider.getBalance(sepoliaWallet.address);
    const robinhoodBal = await robinhoodProvider.getBalance(robinhoodWallet.address);

    console.log(`Keeper EOA:    ${sepoliaWallet.address}`);
    console.log(`Stylus LOB:    ${STYLUS_LOB_ADDRESS}`);
    console.log(`Arb Sepolia:   ${ethers.formatEther(sepoliaBal)} ETH`);
    console.log(`Robinhood:     ${ethers.formatEther(robinhoodBal)} ETH`);
    console.log(`Settlement:    ${ENABLE_SETTLEMENT ? "✅ ON (→ AuraPerps " + AURA_PERPS_ADDRESS + ")" : "❌ OFF"}`);
    console.log(`Assets:        ${ASSETS.join(", ")}`);
    console.log(`Cycle every:   ${INTERVAL_MS / 1000}s\n`);

    await cycle();
    setInterval(cycle, INTERVAL_MS);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
