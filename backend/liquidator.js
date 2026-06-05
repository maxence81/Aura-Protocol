require('dotenv').config({ override: true });
const { ethers } = require("ethers");
const { Client } = require("pg");
const { computeHealth } = require("./healthFactor");

const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const PRIVATE_KEY = process.env.PRIVATE_KEY; // The keeper's wallet
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const PERPS_ADDRESS = process.env.AURA_PERPS_ADDRESS || "0x8AECF449B27BB41E34C04D8C99F4348FF38bB9a2";
const PERPS_ABI = [
    "function positions(uint256) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
    "function liquidatePosition(uint256 positionId) external"
];
const perps = new ethers.Contract(PERPS_ADDRESS, PERPS_ABI, wallet);

const PYTH_IDS = {
    BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    AMZN: "62731dfcc8b8542e52753f208248c3e73fab2ec15422d6f65c2decda71ccea0d",
    NFLX: "8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2",
    AMD: "6969003ef4c5fbb3b57a6be3883102362d05572c2dc7f72b767ad48f4206204b",
    PLTR: "11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0"
};

async function fetchPythPrices() {
    const ids = Object.values(PYTH_IDS);
    const url = `https://hermes.pyth.network/v2/updates/price/latest?` + ids.map(id => `ids[]=${id}`).join("&");
    try {
        const res = await fetch(url);
        const data = await res.json();
        const prices = {};
        for (const entry of data.parsed || []) {
            const px = Number(entry.price.price) * Math.pow(10, entry.price.expo);
            for (const [sym, pythId] of Object.entries(PYTH_IDS)) {
                if (entry.id.toLowerCase() === pythId.toLowerCase()) {
                    prices[sym] = ethers.parseUnits(px.toFixed(2), 18);
                }
            }
        }
        return prices;
    } catch (e) {
        console.error("[Liquidator] Pyth fetch error:", e.message);
        return {};
    }
}

async function runLiquidator() {
    console.log("==================================================");
    console.log("  DEMARRAGE DU KEEPER DE LIQUIDATION (AURA)       ");
    console.log("==================================================");

    const db = new Client({
        connectionString: process.env.GCP_DB_URL || process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await db.connect();
    } catch (err) {
        console.error("[Liquidator] Database connection failed", err.message);
        return;
    }

    setInterval(async () => {
        try {
            const prices = await fetchPythPrices();
            if (Object.keys(prices).length === 0) return;

            // Fetch all open positions across the entire protocol
            const openRes = await db.query(
                "SELECT position_id FROM positions_opened WHERE position_id NOT IN (SELECT position_id FROM positions_closed)"
            );

            if (openRes.rows.length === 0) return;
            
            const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

            for (const row of openRes.rows) {
                const posId = row.position_id;
                try {
                    const pos = await perps.positions(posId);
                    if (!pos.isOpen) continue;

                    const priceWei = prices[pos.asset];
                    if (!priceWei) continue;

                    const { healthBps } = computeHealth({
                        isLong: pos.isLong,
                        collateralAmount: pos.collateralAmount,
                        entryPrice: pos.entryPrice,
                        positionSize: pos.positionSize,
                        openedAt: pos.openedAt
                    }, priceWei, nowSeconds);

                    if (healthBps === 0) {
                        console.log(`[Liquidator] ⚠️ Position #${posId} is bankrupt (Health 0%). Liquidating...`);
                        try {
                            const tx = await perps.liquidatePosition(posId);
                            await tx.wait();
                            console.log(`[Liquidator] ✅ Successfully liquidated #${posId}. Tx: ${tx.hash}`);
                        } catch (txErr) {
                            // If reverted, maybe already liquidated or in grace period
                            if (!txErr.message.includes("Position not open")) {
                                console.error(`[Liquidator] ❌ Failed to liquidate #${posId}:`, txErr.shortMessage || txErr.message);
                            }
                        }
                    }
                } catch (err) {
                    if (err.code === "CALL_EXCEPTION" || (err.message && err.message.includes("429"))) {
                        // Rate limit ou RPC surcharge, on ignore silencieusement
                    } else {
                        console.error(`[Liquidator] Failed to check #${posId}:`, err.shortMessage || err.message);
                    }
                }
                
                // Sleep pour eviter le rate limit RPC d'Alchemy
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (err) {
            console.error("[Liquidator] Scan cycle error:", err.message);
        }
    }, 15000); // Check every 15 seconds
}

runLiquidator();
