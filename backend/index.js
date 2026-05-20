// Force-load .env first with override so process-wide env vars (e.g. a stale
// STYLUS_LOB_ADDRESS set at the OS user level) don't shadow the .env file.
require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const { runAuraCommittee } = require("./agent");
const { prepareExecution } = require("./executor");
const {
    startAutomation,
    pauseStrategy,
    resumeStrategy,
    cancelStrategy,
    listStrategies,
    getStrategy,
    restoreStrategies,
} = require("./automation");
const { getMarketContext, getCorrelationMatrix, getAllPrices, getCoinDetails, getLatestNews } = require("./market");
const { getQuickSentiment } = require("./macroAnalyzer");

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Configuration de l'identité de l'Agent (Stable & Sécurisée)
let agentWallet;
const AGENT_KEY_FILE = path.join(__dirname, ".aura_agent_key");

if (process.env.PRIVATE_KEY) {
    agentWallet = new ethers.Wallet(process.env.PRIVATE_KEY);
} else if (fs.existsSync(AGENT_KEY_FILE)) {
    const savedKey = fs.readFileSync(AGENT_KEY_FILE, "utf8").trim();
    agentWallet = new ethers.Wallet(savedKey);
} else {
    // Génération d'une nouvelle clé si rien n'existe
    agentWallet = ethers.Wallet.createRandom();
    fs.writeFileSync(AGENT_KEY_FILE, agentWallet.privateKey, { mode: 0o600 });
    console.log("🔒 New Secure Agent Key generated and saved locally.");
}

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Log de l'identité de l'Agent au démarrage
console.log("-----------------------------------------");
console.log(`Aura AI Operator (Agent) Address: ${agentWallet.address}`);
console.log("-----------------------------------------");

app.get("/agent-address", (req, res) => {
    res.json({ address: agentWallet.address });
});

app.post("/chat", async (req, res) => {
  try {
    const { message, account, eoa } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    // 1. Comité Multi-Agents (now includes macro analysis)
    const { proposal, audit, macroAnalysis } = await runAuraCommittee(message, account, eoa);

    // 2. Rejet si non sécurisé
    if (!audit.isSafe) {
        return res.json({
            status: "rejected",
            intent: proposal,
            rationale: `REJETÉ : ${audit.auditReport}`,
            macroAnalysis
        });
    }

    // 3. Préparer les données (on ne lance plus l'automatisation ici, on attend l'approbation du user)
    const txParams = await prepareExecution(proposal);

    res.json({
      status: "awaiting_signature",
      intent: proposal,
      rationale: audit.rationale,
      txParams: txParams, // Ces données seront envoyées au wallet de l'utilisateur
      macroAnalysis // Include macro analysis in response
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ 
        status: "error", 
        message: error.message
    });
  }
});

app.post("/approve-strategy", async (req, res) => {
  try {
    const { strategyId, txParams, accountAddress } = req.body;
    
    if (txParams.automation && txParams.automation.isAutomated) {
        startAutomation(
            strategyId, 
            txParams.automation.totalSwaps, 
            txParams.automation.intervalSeconds,
            txParams,
            accountAddress,
            txParams.automation.initialDelayMs || 0
        );
        res.json({ status: "success", message: "Strategy scheduled successfully." });
    } else {
        res.status(400).json({ error: "Strategy is not automated." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/api/executions", (req, res) => {
    try {
        const EXECUTIONS_FILE = path.join(__dirname, "executions.json");
        if (fs.existsSync(EXECUTIONS_FILE)) {
            const content = fs.readFileSync(EXECUTIONS_FILE, "utf8");
            res.json(JSON.parse(content));
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Strategy lifecycle endpoints ──────────────────────────────────────
// These endpoints make automated strategies controllable (and survive
// frontend page refreshes).

app.get("/api/strategies", (req, res) => {
    try {
        const all = listStrategies();
        const accountFilter = req.query.account;
        const filtered = accountFilter
            ? all.filter((s) => (s.accountAddress || "").toLowerCase() === String(accountFilter).toLowerCase())
            : all;
        res.json(filtered);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/strategies/:id", (req, res) => {
    const s = getStrategy(req.params.id);
    if (!s) return res.status(404).json({ error: "Strategy not found" });
    res.json(s);
});

app.post("/api/strategies/:id/pause", (req, res) => {
    const result = pauseStrategy(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
});

app.post("/api/strategies/:id/resume", (req, res) => {
    const result = resumeStrategy(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
});

app.post("/api/strategies/:id/cancel", (req, res) => {
    const result = cancelStrategy(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
});

// ── Market Data Endpoints ──────────────────────────────────────────

app.get("/api/market-context", async (req, res) => {
  try {
    const context = await getMarketContext();
    res.json(context);
  } catch (error) {
    console.error("Market context error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/prices", async (req, res) => {
  try {
    const prices = await getAllPrices();
    res.json(prices);
  } catch (error) {
    console.error("Prices error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/correlations", async (req, res) => {
  try {
    const correlations = await getCorrelationMatrix();
    res.json(correlations);
  } catch (error) {
    console.error("Correlations error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sentiment", async (req, res) => {
  try {
    const sentiment = await getQuickSentiment();
    res.json(sentiment);
  } catch (error) {
    console.error("Sentiment error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/update-oracle", async (req, res) => {
  try {
    const { asset, price } = req.body;
    if (!asset || !price) return res.status(400).json({ error: "Asset and price are required" });

    console.log(`\n🔮 [Oracle Service] Update request for ${asset} at $${price}`);
    
    const provider = new ethers.JsonRpcProvider("https://rpc.testnet.chain.robinhood.com");
    const signer = agentWallet.connect(provider);
    
    const MOCK_ORACLE_ADDR = process.env.MOCK_ORACLE_ADDRESS || "0x0df0FcA88c9DefC9672301892fe2c4f0f9fF5391";
    const oracleAbi = ["function setPrice(string calldata asset, uint256 price) external"];
    const oracle = new ethers.Contract(MOCK_ORACLE_ADDR, oracleAbi, signer);

    const priceWei = ethers.parseUnits(price.toString(), 18);
    console.log(`🛰️  [Oracle Service] Sending TX to update ${asset}...`);
    
    // Let ethers handle the nonce automatically, but await strictly to avoid overlaps
    const tx = await oracle.setPrice(asset, priceWei);
    console.log(`🔗 [Oracle Service] TX1 Sent: ${tx.hash}. Waiting...`);
    await tx.wait(); 
    
    // Also update the variant (e.g. if BTC, update BTC-PERP too)
    const variant = asset.includes("-PERP") ? asset.split("-")[0] : `${asset}-PERP`;
    console.log(`🛰️  [Oracle Service] Sending TX to update variant ${variant}...`);
    
    const tx2 = await oracle.setPrice(variant, priceWei);
    console.log(`🔗 [Oracle Service] TX2 Sent: ${tx2.hash}. Waiting...`);
    await tx2.wait();
    
    console.log(`✅ [Oracle Service] Oracle Updated successfully (Both ${asset} & ${variant})`);

    res.json({ status: "success", txHash: tx.hash });
  } catch (error) {
    console.error("❌ [Oracle Service] Update error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/coins", async (req, res) => {
  try {
    const coins = await getCoinDetails();
    res.json(coins);
  } catch (error) {
    console.error("Coins detail error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/news", async (req, res) => {
  try {
    const news = await getLatestNews();
    res.json(news);
  } catch (error) {
    console.error("News error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ── Intelligence Vault Endpoints ──────────────────────────────────────

const { runAuraFundManager, executeStrategiesOnChain, readVaultState, VAULT_CONFIG } = require("./vaultAgent");

const vaultProvider = new ethers.JsonRpcProvider("https://rpc.testnet.chain.robinhood.com");
const INTELLIGENCE_VAULT_ADDRESS = process.env.INTELLIGENCE_VAULT_ADDRESS || "0x0000000000000000000000000000000000000000";

/**
 * POST /api/vault/analyze
 * Triggers the multi-agent AI pipeline to generate a strategy proposal.
 * Returns the proposal, risk assessment, and encoded calldata (if approved).
 */
app.post("/api/vault/analyze", async (req, res) => {
  try {
    const vaultAddr = req.body.vaultAddress || INTELLIGENCE_VAULT_ADDRESS;
    console.log(`\n🧠 [Vault API] Strategy analysis requested for vault: ${vaultAddr}`);

    const result = await runAuraFundManager(vaultAddr, vaultProvider);
    res.json(result);
  } catch (error) {
    console.error("Vault analysis error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

/**
 * POST /api/vault/execute
 * Executes approved strategies on-chain via the AI executor wallet.
 * Requires strategies array from /api/vault/analyze.
 */
app.post("/api/vault/execute", async (req, res) => {
  try {
    const { strategies, vaultAddress } = req.body;
    if (!strategies || !strategies.length) {
      return res.status(400).json({ error: "No strategies provided" });
    }

    const vaultAddr = vaultAddress || INTELLIGENCE_VAULT_ADDRESS;
    const executorWallet = agentWallet.connect(vaultProvider);

    console.log(`\n⚡ [Vault API] Executing ${strategies.length} strategies on-chain...`);
    const results = await executeStrategiesOnChain(strategies, vaultAddr, executorWallet);

    res.json({ status: "executed", results });
  } catch (error) {
    console.error("Vault execution error:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

/**
 * GET /api/vault/status
 * Returns current vault state: TVL, allocations, exposure, utilization.
 */
app.get("/api/vault/status", async (req, res) => {
  try {
    const vaultAddr = req.query.address || INTELLIGENCE_VAULT_ADDRESS;
    const state = await readVaultState(vaultAddr, vaultProvider);
    res.json(state);
  } catch (error) {
    console.error("Vault status error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/orderbook/:asset
 * Returns the active Limit Order Book data for the given asset from the
 * AuraPerpsRouter (which proxies to whichever LOB is wired — Stylus or
 * Solidity fallback). Levels are aggregated by price for a clean ladder.
 */
app.get("/api/orderbook/:asset", async (req, res) => {
  try {
    const asset = req.params.asset;
    const depth = Math.max(1, Math.min(50, parseInt(req.query.depth, 10) || 12));
    const source = (req.query.source || "router").toString().toLowerCase();

    // ── Direct Stylus LOB mode (Arbitrum Sepolia) ──
    // Skip the Solidity router entirely and read get_active_orders_sorted from
    // the Stylus contract. Used by the Live Order Book widget on the chat
    // page after a LIMIT_ORDER is signed.
    if (source === "stylus") {
      const stylusAddr = process.env.STYLUS_LOB_ADDRESS;
      if (!stylusAddr) return res.status(500).json({ error: "Missing STYLUS_LOB_ADDRESS" });

      const STYLUS_LOB_ABI = [
        "function get_active_orders_sorted(uint256 asset_hash, bool is_long, uint256 max_results) view returns (uint256[] ids, uint256[] prices, uint256[] sizes)",
        "function get_book_depth(uint256 asset_hash) view returns (uint256, uint256)",
        "function get_stats() view returns (uint256, uint256, uint256)",
      ];
      const sepoliaRpc = process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
      const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
      const stylus = new ethers.Contract(stylusAddr, STYLUS_LOB_ABI, sepoliaProvider);

      // Asset hash convention must match buildLimitOrderTx in agent.js:
      //   uint256(keccak256(abi.encodePacked(symbol.toUpperCase())))
      const assetHash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(asset.toUpperCase())));

      try {
        const [bidsRaw, asksRaw, depthRaw] = await Promise.all([
          stylus.get_active_orders_sorted(assetHash, true,  depth),
          stylus.get_active_orders_sorted(assetHash, false, depth),
          stylus.get_book_depth(assetHash),
        ]);

        const decode = (sortedTuple) => {
          const out = [];
          for (let i = 0; i < sortedTuple[0].length; i++) {
            out.push({
              price: Number(ethers.formatUnits(sortedTuple[1][i], 18)),
              size:  Number(ethers.formatUnits(sortedTuple[2][i], 18)),
            });
          }
          return out;
        };

        let bids = decode(bidsRaw);
        let asks = decode(asksRaw);

        let bCum = 0;
        bids = bids.map((row) => ({ ...row, total: (bCum += row.size) }));
        let aCum = 0;
        for (let i = asks.length - 1; i >= 0; i--) { aCum += asks[i].size; asks[i].total = aCum; }

        return res.json({
          bids, asks, depth,
          source: "stylus",
          chain: "arbitrumSepolia",
          contract: stylusAddr,
          bookDepth: { bids: Number(depthRaw[0]), asks: Number(depthRaw[1]) },
        });
      } catch (stylusErr) {
        // Don't 500 the UI — return an empty book and keep the page alive.
        console.warn(`[orderbook/stylus] RPC error for ${asset}:`, stylusErr.shortMessage || stylusErr.message);
        return res.json({
          bids: [], asks: [], depth,
          source: "stylus",
          chain: "arbitrumSepolia",
          contract: stylusAddr,
          bookDepth: { bids: 0, asks: 0 },
          warning: "rpc_unavailable",
        });
      }
    }

    // ── Default: read via the Solidity router (Robinhood Chain) ──
    const routerAddr = process.env.LOB_ROUTER_ADDRESS || process.env.ROUTER_ADDRESS;
    if (!routerAddr) return res.status(500).json({ error: "Missing LOB_ROUTER_ADDRESS" });

    // Prefer the new sorted view (top-N best-first per side) and fall back to
    // the legacy unsorted view on contracts that haven't been redeployed yet.
    const ROUTER_ABI = [
      "function getOrderBookSorted(string asset, uint256 depth) view returns (uint256[] bidIds, uint256[] bidPrices, uint256[] bidSizes, uint256[] askIds, uint256[] askPrices, uint256[] askSizes)",
      "function getOrderBook(string asset) view returns (uint256[] bidIds, uint256[] askIds)",
      "function getOrderDetails(uint256 orderId) view returns (address user, uint256 assetHash, bool isLong, uint256 collateral, uint256 leverage, uint256 limitPrice, uint256 timestamp, uint256 status)",
    ];

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com");
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);

    let rawBids = []; // {price: number, size: number}
    let rawAsks = [];

    try {
      const sorted = await router.getOrderBookSorted(asset, depth);
      for (let i = 0; i < sorted.bidIds.length; i++) {
        rawBids.push({
          price: Number(ethers.formatUnits(sorted.bidPrices[i], 18)),
          size:  Number(ethers.formatUnits(sorted.bidSizes[i],  18)),
        });
      }
      for (let i = 0; i < sorted.askIds.length; i++) {
        rawAsks.push({
          price: Number(ethers.formatUnits(sorted.askPrices[i], 18)),
          size:  Number(ethers.formatUnits(sorted.askSizes[i],  18)),
        });
      }
    } catch (sortedErr) {
      // Older router/LOB without get_active_orders_sorted: fall back to
      // fetching every active order one-by-one and sorting in JS.
      const [bidIds, askIds] = await router.getOrderBook(asset);
      const fetchSide = async (ids) => {
        const out = [];
        for (const id of ids) {
          const d = await router.getOrderDetails(id);
          out.push({
            price: Number(ethers.formatUnits(d.limitPrice,  18)),
            size:  Number(ethers.formatUnits(d.collateral, 18)) * Number(d.leverage),
          });
        }
        return out;
      };
      rawBids = await fetchSide(bidIds);
      rawAsks = await fetchSide(askIds);
    }

    // Aggregate by price level so the UI ladder collapses identical limits.
    const aggregate = (rows) => {
      const map = new Map();
      for (const r of rows) {
        if (!Number.isFinite(r.price) || r.price <= 0) continue;
        const key = r.price.toFixed(8);
        map.set(key, (map.get(key) || 0) + r.size);
      }
      return Array.from(map.entries()).map(([price, size]) => ({ price: Number(price), size }));
    };

    let bids = aggregate(rawBids).sort((a, b) => b.price - a.price); // descending
    let asks = aggregate(rawAsks).sort((a, b) => a.price - b.price); // ascending

    // Cumulative totals — for bids walk top→bottom; for asks the convention is
    // bottom-up (worst→best) so the cumulative figure on the best ask matches
    // total depth above the spread.
    let bCum = 0;
    bids = bids.slice(0, depth).map((row) => ({ ...row, total: (bCum += row.size) }));

    asks = asks.slice(0, depth);
    let aCum = 0;
    for (let i = asks.length - 1; i >= 0; i--) {
      aCum += asks[i].size;
      asks[i].total = aCum;
    }

    res.json({ bids, asks, depth, source: "router" });
  } catch (error) {
    console.error("Orderbook fetch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ── My Open Orders (Stylus LOB, Arbitrum Sepolia) ─────────────────────
// Scans all orders in the Stylus LOB and returns those owned by `address`
// that are still ACTIVE (status=1). Used by the /trade "Orders" tab.
app.get("/api/my-orders/:address", async (req, res) => {
  try {
    const userAddr = req.params.address.toLowerCase();
    const stylusAddr = process.env.STYLUS_LOB_ADDRESS;
    if (!stylusAddr) return res.status(500).json({ error: "Missing STYLUS_LOB_ADDRESS" });

    const STYLUS_ABI = [
      "function get_stats() view returns (uint256, uint256, uint256)",
      "function get_order(uint256 order_id) view returns (address, uint256, bool, uint256, uint256, uint256, uint256, uint256)",
    ];
    const sepoliaRpc = process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
    const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
    const stylus = new ethers.Contract(stylusAddr, STYLUS_ABI, sepoliaProvider);

    const stats = await stylus.get_stats();
    const nextId = Number(stats[0]);

    // Reverse-lookup hash → symbol
    const SYMBOLS = ["BTC", "ETH", "TSLA", "AMZN", "AMD", "NFLX", "PLTR"];
    const hashToSymbol = {};
    for (const sym of SYMBOLS) {
      hashToSymbol[BigInt(ethers.keccak256(ethers.toUtf8Bytes(sym))).toString()] = sym;
    }

    const STATUS_ACTIVE = 1n;
    const orders = [];

    // Scan last 200 orders max (performance bound for demo)
    const start = Math.max(0, nextId - 200);
    for (let i = start; i < nextId; i++) {
      const o = await stylus.get_order(BigInt(i));
      if (o[0].toLowerCase() !== userAddr) continue;
      if (BigInt(o[7]) !== STATUS_ACTIVE) continue;

      const assetHash = BigInt(o[1]).toString();
      orders.push({
        id: i,
        asset: hashToSymbol[assetHash] || "UNKNOWN",
        isLong: o[2],
        collateral: Number(ethers.formatUnits(o[3], 18)),
        leverage: Number(o[4]),
        size: Number(ethers.formatUnits(o[3], 18)) * Number(o[4]),
        limitPrice: Number(ethers.formatUnits(o[5], 18)),
        timestamp: Number(o[6]),
      });
    }

    res.json({ orders, total: nextId, scanned: nextId - start });
  } catch (error) {
    console.warn("My-orders fetch error (returning empty):", error.shortMessage || error.message);
    // Don't 500 the UI — empty list with a warning keeps the page rendering.
    res.json({ orders: [], total: 0, scanned: 0, warning: "rpc_unavailable" });
  }
});

// -- Gasless Execution (Meta-Transaction Relay) ────────────────────────
// The backend agent EOA is registered as `aiAgent` on the user's AuraAccount.
// When the user opts for gasless mode, the frontend sends the signed intent
// (txParams) here, and the backend executes it on-chain via executeBatchByAgent.
// The user pays ZERO gas -- the agent EOA sponsors it.
app.post("/api/gasless-execute", async (req, res) => {
  try {
    const { accountAddress, targets, values, datas } = req.body;
    if (!accountAddress || !targets || !values || !datas) {
      return res.status(400).json({ error: "Missing accountAddress, targets, values, or datas" });
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com");
    const signer = agentWallet.connect(provider);

    const ACCOUNT_ABI = [
      "function executeBatchByAgent(address[] dest, uint256[] value, bytes[] func) external"
    ];
    const auraAccount = new ethers.Contract(accountAddress, ACCOUNT_ABI, signer);

    console.log(`[Gasless] Executing batch on behalf of ${accountAddress} (${targets.length} calls)...`);
    const tx = await auraAccount.executeBatchByAgent(targets, values, datas);
    const receipt = await tx.wait();

    console.log(`[Gasless] Success! TX: ${receipt.hash} | Gas: ${receipt.gasUsed}`);
    res.json({
      status: "success",
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    console.error("[Gasless] Execution failed:", error.shortMessage || error.message);
    res.status(500).json({ error: error.shortMessage || error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aura Backend (Non-Custodial) running on port ${PORT}`);
  console.log(`Intelligence Vault: ${INTELLIGENCE_VAULT_ADDRESS}`);

  // Restore any persisted strategies and re-arm their timers.
  try {
    restoreStrategies();
  } catch (err) {
    console.error("Failed to restore strategies:", err.message);
  }

  // Start autonomous 24/7 loop
  startAutonomousVaultAgent();
});

async function startAutonomousVaultAgent() {
    console.log("🚀 Starting 24/7 Autonomous Vault Agent...");
    const executorWallet = agentWallet.connect(vaultProvider);
    
    // Run every 1 minute (60000 ms) for hackathon demo purposes.
    const INTERVAL_MS = 60 * 1000; 
    
    const runCycle = async () => {
        try {
            console.log("\n⏳ [Auto-Pilot 24/7] Waking up for scheduled strategy cycle...");
            const result = await runAuraFundManager(INTELLIGENCE_VAULT_ADDRESS, vaultProvider);
            
            if (result.status === "approved" && result.encodedStrategies && result.encodedStrategies.length > 0) {
                console.log(`⚡ [Auto-Pilot 24/7] Executing ${result.encodedStrategies.length} approved strategies...`);
                await executeStrategiesOnChain(result.encodedStrategies, INTELLIGENCE_VAULT_ADDRESS, executorWallet);
            } else {
                console.log("💤 [Auto-Pilot 24/7] No actionable strategies this cycle. Going back to sleep.");
            }
        } catch (error) {
            console.error("❌ [Auto-Pilot 24/7] Error during autonomous cycle:", error.message);
        }
    };

    setInterval(runCycle, INTERVAL_MS);
    
    // Trigger first run shortly after startup
    setTimeout(runCycle, 5000);
}
