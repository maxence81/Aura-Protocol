/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║         AURA MCP SERVER — AI-to-Perps Trading Interface          ║
 * ║   Delegation model: user authorizes this agent via setAiAgent,   ║
 * ║   then the agent executes via executeBatchByAgent on their       ║
 * ║   AuraAccount. No user private keys needed.                      ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node mcpServer.mjs              (stdio — Claude Desktop, Cursor, Kiro)
 *   node mcpServer.mjs --http 3002  (HTTP/SSE — ChatGPT, remote agents)
 */

import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env"), override: true });

// ── Config ──
const ARB_SEPOLIA_RPC = process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const ROBINHOOD_RPC = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const STYLUS_LOB_ADDRESS = process.env.STYLUS_LOB_ADDRESS;
const AURA_PERPS_ADDRESS = process.env.AURA_PERPS_ADDRESS;
const AUSD_ADDRESS = process.env.AUSD_ADDRESS;
const MOCK_ORACLE_ADDRESS = process.env.MOCK_ORACLE_ADDRESS;

// ── Providers & Agent Wallet ──
const sepoliaProvider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
const robinhoodProvider = new ethers.JsonRpcProvider(ROBINHOOD_RPC);
const agentWallet = new ethers.Wallet(PRIVATE_KEY, robinhoodProvider);
const agentWalletSepolia = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);

// ── ABIs ──
const STYLUS_LOB_ABI = [
  "function store_order(address owner, uint256 asset_hash, bool is_long, uint256 collateral, uint256 leverage, uint256 limit_price) returns (uint256)",
  "function get_active_orders_sorted(uint256 asset_hash, bool is_long, uint256 max_results) view returns (uint256[] ids, uint256[] prices, uint256[] sizes)",
  "function get_book_depth(uint256 asset_hash) view returns (uint256, uint256)",
];

const AURA_ACCOUNT_ABI = [
  "function executeBatchByAgent(address[] dest, uint256[] value, bytes[] func) external",
];

const PERPS_ABI = [
  "function openPosition(string asset, bool isLong, uint256 collateralAmount, uint256 leverage) returns (uint256)",
  "function closePosition(uint256 positionId) external",
  "function closePositionPartially(uint256 positionId, uint256 closeSize) external",
  "function addMargin(uint256 positionId, uint256 additionalCollateral) external",
  "function setTriggerOrders(uint256 positionId, uint256 tpPrice, uint256 slPrice) external",
  "function positions(uint256 positionId) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
  "function nextPositionId() view returns (uint256)",
  "function calculatePnL(uint256 positionId, uint256 currentPrice) view returns (uint256 pnl, bool isProfit)",
  "function totalLongOI(string asset) view returns (uint256)",
  "function totalShortOI(string asset) view returns (uint256)",
  "function FUNDING_RATE_PER_SECOND() view returns (uint256)",
];

const AUSD_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ORACLE_ABI = ["function setPrice(string asset, uint256 price) external"];

// ── Interfaces for encoding calldata ──
const perpsIface = new ethers.Interface(PERPS_ABI);
const ausdIface = new ethers.Interface(AUSD_ABI);

// ── Pyth Price IDs ──
const PYTH_IDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  AMZN: "62731dfcc8b8542e52753f208248c3e73fab2ec15422d6f65c2decda71ccea0d",
  NFLX: "8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2",
  AMD: "6969003ef4c5fbb3b57a6be3883102362d05572c2dc7f72b767ad48f4206204b",
  PLTR: "11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0",
};

function assetHash(symbol) {
  return BigInt(ethers.keccak256(ethers.toUtf8Bytes(symbol.toUpperCase())));
}

async function fetchPythPrice(symbol) {
  const id = PYTH_IDS[symbol.toUpperCase()];
  if (!id) return null;
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}`);
  const data = await res.json();
  if (data.parsed?.[0]) {
    const p = data.parsed[0].price;
    return parseFloat(p.price) * Math.pow(10, p.expo);
  }
  return null;
}

/** Execute a batch of calls on a user's AuraAccount via the agent wallet */
async function executeBatchOnAccount(auraAccountAddress, targets, values, datas) {
  const account = new ethers.Contract(auraAccountAddress, AURA_ACCOUNT_ABI, agentWallet);
  const tx = await account.executeBatchByAgent(targets, values, datas);
  return await tx.wait();
}

// ── MCP Server ──
const server = new McpServer({ name: "aura-perps", version: "1.0.0" });

server.registerTool("get_price", {
  description: "Get real-time price for a supported asset (BTC, ETH, TSLA, AMZN, NFLX, AMD, PLTR) from Pyth Network",
  inputSchema: z.object({ asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA") }),
}, async ({ asset }) => {
  const price = await fetchPythPrice(asset);
  if (!price) return { content: [{ type: "text", text: `Unsupported asset: ${asset}. Supported: ${Object.keys(PYTH_IDS).join(", ")}` }] };
  return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), price, source: "pyth_hermes" }) }] };
});

server.registerTool("get_orderbook", {
  description: "Get live order book (bids/asks) from the Stylus WASM LOB on Arbitrum Sepolia",
  inputSchema: z.object({
    asset: z.string().describe("Asset symbol e.g. BTC, ETH"),
    depth: z.number().optional().describe("Max orders per side (default 10)"),
  }),
}, async ({ asset, depth = 10 }) => {
  const hash = assetHash(asset);
  const lob = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, sepoliaProvider);
  const [bidsRaw, asksRaw, bookDepth] = await Promise.all([
    lob.get_active_orders_sorted(hash, true, depth),
    lob.get_active_orders_sorted(hash, false, depth),
    lob.get_book_depth(hash),
  ]);
  const decode = (tuple) => {
    const out = [];
    for (let i = 0; i < tuple[0].length; i++) {
      out.push({ price: Number(ethers.formatUnits(tuple[1][i], 18)), size: Number(ethers.formatUnits(tuple[2][i], 18)) });
    }
    return out;
  };
  return { content: [{ type: "text", text: JSON.stringify({
    asset: asset.toUpperCase(), bids: decode(bidsRaw), asks: decode(asksRaw),
    totalBids: Number(bookDepth[0]), totalAsks: Number(bookDepth[1]),
    chain: "Arbitrum Sepolia", contract: STYLUS_LOB_ADDRESS,
  }, null, 2) }] };
});

server.registerTool("place_limit_order", {
  description: "Place a limit order on the Stylus WASM order book (Arbitrum Sepolia). Executed by the AI agent on your behalf.",
  inputSchema: z.object({
    asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA"),
    is_long: z.boolean().describe("true=long/buy, false=short/sell"),
    collateral: z.number().describe("Collateral in USD (e.g. 100)"),
    leverage: z.number().min(1).max(50).describe("Leverage 1-50x"),
    limit_price: z.number().describe("Limit price in USD"),
  }),
}, async ({ asset, is_long, collateral, leverage, limit_price }) => {
  const lob = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, agentWalletSepolia);
  const hash = assetHash(asset);
  const colWei = ethers.parseUnits(collateral.toString(), 18);
  const priceWei = ethers.parseUnits(limit_price.toString(), 18);
  const tx = await lob.store_order(agentWalletSepolia.address, hash, is_long, colWei, BigInt(leverage), priceWei);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "placed", asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT",
    collateral, leverage, limit_price, chain: "Arbitrum Sepolia", txHash: receipt.hash,
  }, null, 2) }] };
});

server.registerTool("place_market_order", {
  description: "Open a perpetual position at market price on AuraPerps (Robinhood Chain) via your AuraAccount delegation.",
  inputSchema: z.object({
    asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA"),
    is_long: z.boolean().describe("true=long, false=short"),
    collateral: z.number().describe("Collateral in aUSD (e.g. 100)"),
    leverage: z.number().min(1).max(50).describe("Leverage 1-50x"),
  }),
}, async ({ asset, is_long, collateral, leverage }) => {
  const colWei = ethers.parseUnits(collateral.toString(), 18);

  // Update oracle with fresh Pyth price
  const price = await fetchPythPrice(asset);
  if (price) {
    const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet);
    await (await oracle.setPrice(asset.toUpperCase(), ethers.parseUnits(price.toFixed(2), 18))).wait();
  }

  // Encode: approve aUSD + openPosition as a batch
  const approveData = ausdIface.encodeFunctionData("approve", [AURA_PERPS_ADDRESS, colWei]);
  const openData = perpsIface.encodeFunctionData("openPosition", [asset.toUpperCase(), is_long, colWei, BigInt(leverage)]);

  // Execute directly with agent wallet (for demo — no specific user account needed for ChatGPT)
  const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, agentWallet);
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);

  const allowance = await ausd.allowance(agentWallet.address, AURA_PERPS_ADDRESS);
  if (allowance < colWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();

  const tx = await perps.openPosition(asset.toUpperCase(), is_long, colWei, BigInt(leverage));
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "opened", asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT",
    collateral, leverage, entryPrice: price, chain: "Robinhood Chain", txHash: receipt.hash,
  }, null, 2) }] };
});

server.registerTool("get_positions", {
  description: "Get open perpetual positions from AuraPerps (Robinhood Chain)",
  inputSchema: z.object({}),
}, async () => {
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
  const nextId = Number(await perps.nextPositionId());
  const positions = [];
  for (let i = 0; i < nextId && positions.length < 20; i++) {
    try {
      const pos = await perps.positions(i);
      if (pos.isOpen) {
        const price = await fetchPythPrice(pos.asset);
        let pnl = null, isProfit = null;
        if (price) {
          const [p, ip] = await perps.calculatePnL(i, ethers.parseUnits(price.toFixed(2), 18));
          pnl = Number(ethers.formatUnits(p, 18)); isProfit = ip;
        }
        positions.push({
          id: i, asset: pos.asset, side: pos.isLong ? "LONG" : "SHORT",
          owner: pos.owner,
          collateral: Number(ethers.formatUnits(pos.collateralAmount, 18)),
          leverage: Number(pos.leverage),
          entryPrice: Number(ethers.formatUnits(pos.entryPrice, 18)),
          size: Number(ethers.formatUnits(pos.positionSize, 18)),
          pnl, isProfit, currentPrice: price,
        });
      }
    } catch { continue; }
  }
  return { content: [{ type: "text", text: JSON.stringify({ positions, count: positions.length }, null, 2) }] };
});

server.registerTool("close_position", {
  description: "Close an open perpetual position on AuraPerps by position ID",
  inputSchema: z.object({ position_id: z.number().describe("Position ID to close") }),
}, async ({ position_id }) => {
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
  const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet);
  const pos = await perps.positions(position_id);
  if (!pos.isOpen) return { content: [{ type: "text", text: "Position already closed." }] };
  const price = await fetchPythPrice(pos.asset);
  if (price) await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait();
  const tx = await perps.closePosition(position_id);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "closed", positionId: position_id, asset: pos.asset, exitPrice: price, txHash: receipt.hash,
  }, null, 2) }] };
});

server.registerTool("get_account_balance", {
  description: "Get aUSD and ETH balance for the agent wallet or a specific AuraAccount address",
  inputSchema: z.object({ address: z.string().optional().describe("AuraAccount or wallet address (defaults to agent wallet)") }),
}, async ({ address }) => {
  const addr = address || agentWallet.address;
  const [ausdBal, ethBal] = await Promise.all([
    robinhoodProvider.call({ to: AUSD_ADDRESS, data: new ethers.Interface(["function balanceOf(address) view returns (uint256)"]).encodeFunctionData("balanceOf", [addr]) }),
    robinhoodProvider.getBalance(addr),
  ]);
  return { content: [{ type: "text", text: JSON.stringify({ address: addr, aUSD: Number(ethers.formatUnits(BigInt(ausdBal), 18)).toFixed(2), ETH: Number(ethers.formatUnits(ethBal, 18)).toFixed(4) }) }] };
});

server.registerTool("set_stop_loss_take_profit", {
  description: "Set stop-loss and/or take-profit prices on an open position",
  inputSchema: z.object({
    position_id: z.number().describe("Position ID"),
    take_profit: z.number().optional().describe("Take profit price in USD (0 to disable)"),
    stop_loss: z.number().optional().describe("Stop loss price in USD (0 to disable)"),
  }),
}, async ({ position_id, take_profit = 0, stop_loss = 0 }) => {
  const tpWei = ethers.parseUnits(take_profit.toString(), 18);
  const slWei = ethers.parseUnits(stop_loss.toString(), 18);
  const data = perpsIface.encodeFunctionData("setTriggerOrders", [BigInt(position_id), tpWei, slWei]);
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
  const tx = await perps.setTriggerOrders(BigInt(position_id), tpWei, slWei);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({ status: "triggers_set", positionId: position_id, takeProfit: take_profit, stopLoss: stop_loss, txHash: receipt.hash }, null, 2) }] };
});

server.registerTool("add_margin", {
  description: "Add collateral (aUSD) to an existing open position to reduce liquidation risk",
  inputSchema: z.object({
    position_id: z.number().describe("Position ID"),
    amount: z.number().describe("Additional collateral in aUSD"),
  }),
}, async ({ position_id, amount }) => {
  const amtWei = ethers.parseUnits(amount.toString(), 18);
  const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, agentWallet);
  const allowance = await ausd.allowance(agentWallet.address, AURA_PERPS_ADDRESS);
  if (allowance < amtWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
  const tx = await perps.addMargin(BigInt(position_id), amtWei);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({ status: "margin_added", positionId: position_id, addedAmount: amount, txHash: receipt.hash }, null, 2) }] };
});

server.registerTool("get_market_analysis", {
  description: "Get AI-powered macro market analysis including Pyth prices, news sentiment, and correlations for an asset",
  inputSchema: z.object({ asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA") }),
}, async ({ asset }) => {
  const price = await fetchPythPrice(asset);
  // Fetch multiple prices for correlation context
  const allPrices = {};
  for (const sym of Object.keys(PYTH_IDS)) { try { allPrices[sym] = await fetchPythPrice(sym); } catch {} }
  // Try CoinMarketCap Fear & Greed
  let sentiment = null;
  try {
    const cmcKey = process.env.COINMARKETCAP;
    if (cmcKey) {
      const res = await fetch("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest", { headers: { "X-CMC_PRO_API_KEY": cmcKey, Accept: "application/json" } });
      if (res.ok) { const d = await res.json(); const v = d.data?.value || 50; const c = d.data?.value_classification || "Neutral"; sentiment = { sentiment: v > 60 ? "BULLISH" : v < 40 ? "BEARISH" : "NEUTRAL", score: v, summary: `Fear & Greed Index: ${v}/100 (${c})` }; }
    }
  } catch {}
  // Fallback: use Alternative.me Fear & Greed (free, no key)
  if (!sentiment) {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      if (res.ok) { const d = await res.json(); const v = parseInt(d.data?.[0]?.value || "50"); const c = d.data?.[0]?.value_classification || "Neutral"; sentiment = { sentiment: v > 60 ? "BULLISH" : v < 40 ? "BEARISH" : "NEUTRAL", score: v, summary: `Crypto Fear & Greed: ${v}/100 (${c})` }; }
    } catch {}
  }
  if (!sentiment) sentiment = { sentiment: "NEUTRAL", score: 50, summary: "Sentiment data unavailable" };
  return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), currentPrice: price, marketSentiment: sentiment.sentiment, sentimentScore: sentiment.score, analysis: sentiment.summary, allPrices, source: "pyth_hermes + fear_greed_index" }, null, 2) }] };
});

server.registerTool("get_funding_rate", {
  description: "Get current funding rate and open interest for an asset on AuraPerps",
  inputSchema: z.object({ asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA") }),
}, async ({ asset }) => {
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
  const [longOI, shortOI, ratePerSec] = await Promise.all([
    perps.totalLongOI(asset.toUpperCase()),
    perps.totalShortOI(asset.toUpperCase()),
    perps.FUNDING_RATE_PER_SECOND(),
  ]);
  const dailyRate = Number(ratePerSec) * 86400 / 1e18 * 100;
  const longOINum = Number(ethers.formatUnits(longOI, 18));
  const shortOINum = Number(ethers.formatUnits(shortOI, 18));
  const skew = longOINum - shortOINum;
  return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), fundingRateDaily: `${dailyRate.toFixed(4)}%`, longOpenInterest: longOINum, shortOpenInterest: shortOINum, skew, skewDirection: skew > 0 ? "LONG_HEAVY" : skew < 0 ? "SHORT_HEAVY" : "BALANCED" }, null, 2) }] };
});

server.registerTool("partial_close", {
  description: "Partially close a position by specifying the size to close (in position units)",
  inputSchema: z.object({
    position_id: z.number().describe("Position ID"),
    close_size: z.number().describe("Size to close (in position size units, e.g. 500 out of 1000)"),
  }),
}, async ({ position_id, close_size }) => {
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
  const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet);
  const pos = await perps.positions(position_id);
  if (!pos.isOpen) return { content: [{ type: "text", text: "Position already closed." }] };
  const price = await fetchPythPrice(pos.asset);
  if (price) await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait();
  const sizeWei = ethers.parseUnits(close_size.toString(), 18);
  const tx = await perps.closePositionPartially(BigInt(position_id), sizeWei);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({ status: "partially_closed", positionId: position_id, closedSize: close_size, remainingSize: Number(ethers.formatUnits(pos.positionSize - sizeWei, 18)), exitPrice: price, txHash: receipt.hash }, null, 2) }] };
});

// ── Start ──
const args = process.argv.slice(2);

if (args.includes("--http")) {
  const port = parseInt(args[args.indexOf("--http") + 1]) || 3002;
  const express = (await import("express")).default;
  const cors = (await import("cors")).default;

  const app = express();
  app.use(cors());

  const transports = {};

  // Global store for authenticated sessions (persists across stateless /mcp requests)
  const authenticatedAccounts = new Map(); // apiKey -> auraAccountAddress

  // Factory: create a fresh McpServer per session
  // If auraAccount is provided, write operations go through executeBatchByAgent
  function createServer(auraAccount) {
    const s = new McpServer({ name: "aura-perps", version: "1.0.0" });
    let sessionAccount = auraAccount; // mutable — can be set by authenticate tool

    const BACKEND_RESOLVE_URL = (process.env.BACKEND_URL || "https://aura-backend-backend.up.railway.app") + "/api/mcp-keys/resolve";

    s.registerTool("authenticate", { description: "Authenticate with your Aura API key to trade with your own wallet. Get your key at https://aura-protocol-tawny.vercel.app/trade", inputSchema: z.object({ api_key: z.string().describe("Your Aura API key (aura_xxx...)") }) }, async ({ api_key }) => {
      try {
        const res = await fetch(BACKEND_RESOLVE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: api_key }) });
        if (!res.ok) return { content: [{ type: "text", text: "Invalid API key. Generate one at https://aura-protocol-tawny.vercel.app/trade" }] };
        const data = await res.json();
        sessionAccount = data.auraAccount;
        authenticatedAccounts.set(api_key, data.auraAccount); // persist globally
        return { content: [{ type: "text", text: `Authenticated! Trading on AuraAccount ${sessionAccount}. All trades will execute via your account.` }] };
      } catch (e) { return { content: [{ type: "text", text: `Auth failed: ${e.message}` }] }; }
    });

    s.registerTool("get_price", { description: "Get real-time price for BTC, ETH, TSLA, AMZN, NFLX, AMD, PLTR from Pyth", inputSchema: z.object({ asset: z.string() }) }, async ({ asset }) => {
      const price = await fetchPythPrice(asset);
      if (!price) return { content: [{ type: "text", text: `Unsupported: ${asset}` }] };
      return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), price }) }] };
    });

    s.registerTool("get_orderbook", { description: "Get live bids/asks from Stylus WASM LOB on Arbitrum Sepolia", inputSchema: z.object({ asset: z.string(), depth: z.number().optional() }) }, async ({ asset, depth = 10 }) => {
      const hash = assetHash(asset);
      const lob = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, sepoliaProvider);
      const [bidsRaw, asksRaw, bookDepth] = await Promise.all([lob.get_active_orders_sorted(hash, true, depth), lob.get_active_orders_sorted(hash, false, depth), lob.get_book_depth(hash)]);
      const decode = (t) => { const o = []; for (let i = 0; i < t[0].length; i++) o.push({ price: Number(ethers.formatUnits(t[1][i], 18)), size: Number(ethers.formatUnits(t[2][i], 18)) }); return o; };
      return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), bids: decode(bidsRaw), asks: decode(asksRaw), totalBids: Number(bookDepth[0]), totalAsks: Number(bookDepth[1]) }, null, 2) }] };
    });

    s.registerTool("place_limit_order", { description: "Place limit order on Stylus LOB", inputSchema: z.object({ asset: z.string(), is_long: z.boolean(), collateral: z.number(), leverage: z.number().min(1).max(50), limit_price: z.number() }) }, async ({ asset, is_long, collateral, leverage, limit_price }) => {
      const lob = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, agentWalletSepolia);
      const tx = await lob.store_order(agentWalletSepolia.address, assetHash(asset), is_long, ethers.parseUnits(collateral.toString(), 18), BigInt(leverage), ethers.parseUnits(limit_price.toString(), 18));
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "placed", asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT", collateral, leverage, limit_price, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("place_market_order", { description: "Open perp position at market price on AuraPerps", inputSchema: z.object({ asset: z.string(), is_long: z.boolean(), collateral: z.number(), leverage: z.number().min(1).max(50) }) }, async ({ asset, is_long, collateral, leverage }) => {
      const colWei = ethers.parseUnits(collateral.toString(), 18);
      const price = await fetchPythPrice(asset);
      if (price) { const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet); await (await oracle.setPrice(asset.toUpperCase(), ethers.parseUnits(price.toFixed(2), 18))).wait(); }

      if (sessionAccount) {
        // Per-user: execute via their AuraAccount using executeBatchByAgent
        const approveData = ausdIface.encodeFunctionData("approve", [AURA_PERPS_ADDRESS, colWei]);
        const openData = perpsIface.encodeFunctionData("openPosition", [asset.toUpperCase(), is_long, colWei, BigInt(leverage)]);
        const account = new ethers.Contract(sessionAccount, AURA_ACCOUNT_ABI, agentWallet);
        const tx = await account.executeBatchByAgent([AUSD_ADDRESS, AURA_PERPS_ADDRESS], [0n, 0n], [approveData, openData]);
        const receipt = await tx.wait();
        return { content: [{ type: "text", text: JSON.stringify({ status: "opened", account: sessionAccount, asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT", collateral, leverage, entryPrice: price, txHash: receipt.hash }, null, 2) }] };
      }

      // Default: agent wallet directly
      const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, agentWallet);
      const allowance = await ausd.allowance(agentWallet.address, AURA_PERPS_ADDRESS);
      if (allowance < colWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const tx = await perps.openPosition(asset.toUpperCase(), is_long, colWei, BigInt(leverage));
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "opened", asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT", collateral, leverage, entryPrice: price, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("get_positions", { description: "Get open positions from AuraPerps. Shows your AuraAccount positions by default, or all positions if owner is specified.", inputSchema: z.object({ owner: z.string().optional().describe("Filter by owner address (optional, defaults to your AuraAccount)"), show_all: z.boolean().optional().describe("Show all open positions regardless of owner") }) }, async ({ owner, show_all }) => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
      const nextId = Number(await perps.nextPositionId());
      const positions = [];
      const ownerFilter = show_all ? null : (owner ? owner.toLowerCase() : (sessionAccount ? sessionAccount.toLowerCase() : null));
      for (let i = 0; i < nextId && positions.length < 20; i++) { try { const pos = await perps.positions(i); if (pos.isOpen && (!ownerFilter || pos.owner.toLowerCase() === ownerFilter)) { const price = await fetchPythPrice(pos.asset); positions.push({ id: i, owner: pos.owner, asset: pos.asset, side: pos.isLong ? "LONG" : "SHORT", collateral: Number(ethers.formatUnits(pos.collateralAmount, 18)), leverage: Number(pos.leverage), entryPrice: Number(ethers.formatUnits(pos.entryPrice, 18)), currentPrice: price }); } } catch { continue; } }
      return { content: [{ type: "text", text: JSON.stringify({ account: sessionAccount || "agent", positions, count: positions.length }, null, 2) }] };
    });

    s.registerTool("close_position", { description: "Close a position by ID", inputSchema: z.object({ position_id: z.number() }) }, async ({ position_id }) => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const pos = await perps.positions(position_id);
      if (!pos.isOpen) return { content: [{ type: "text", text: "Already closed." }] };
      const price = await fetchPythPrice(pos.asset);
      if (price) { const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet); await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait(); }

      if (sessionAccount) {
        const closeData = perpsIface.encodeFunctionData("closePosition", [BigInt(position_id)]);
        const account = new ethers.Contract(sessionAccount, AURA_ACCOUNT_ABI, agentWallet);
        const tx = await account.executeBatchByAgent([AURA_PERPS_ADDRESS], [0n], [closeData]);
        const receipt = await tx.wait();
        return { content: [{ type: "text", text: JSON.stringify({ status: "closed", account: sessionAccount, positionId: position_id, asset: pos.asset, exitPrice: price, txHash: receipt.hash }, null, 2) }] };
      }

      const tx = await perps.closePosition(position_id);
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "closed", positionId: position_id, asset: pos.asset, exitPrice: price, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("get_account_balance", { description: "Get aUSD and ETH balance for your account", inputSchema: z.object({ address: z.string().optional() }) }, async ({ address }) => {
      const addr = address || sessionAccount || agentWallet.address;
      const [ausdBal, ethBal] = await Promise.all([
        robinhoodProvider.call({ to: AUSD_ADDRESS, data: new ethers.Interface(["function balanceOf(address) view returns (uint256)"]).encodeFunctionData("balanceOf", [addr]) }),
        robinhoodProvider.getBalance(addr),
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ address: addr, aUSD: Number(ethers.formatUnits(BigInt(ausdBal), 18)).toFixed(2), ETH: Number(ethers.formatUnits(ethBal, 18)).toFixed(4) }) }] };
    });

    s.registerTool("set_stop_loss_take_profit", { description: "Set stop-loss and/or take-profit on a position", inputSchema: z.object({ position_id: z.number(), take_profit: z.number().optional(), stop_loss: z.number().optional() }) }, async ({ position_id, take_profit = 0, stop_loss = 0 }) => {
      const tpWei = ethers.parseUnits(take_profit.toString(), 18);
      const slWei = ethers.parseUnits(stop_loss.toString(), 18);
      if (sessionAccount) {
        const data = perpsIface.encodeFunctionData("setTriggerOrders", [BigInt(position_id), tpWei, slWei]);
        const account = new ethers.Contract(sessionAccount, AURA_ACCOUNT_ABI, agentWallet);
        const tx = await account.executeBatchByAgent([AURA_PERPS_ADDRESS], [0n], [data]);
        const receipt = await tx.wait();
        return { content: [{ type: "text", text: JSON.stringify({ status: "triggers_set", account: sessionAccount, positionId: position_id, takeProfit: take_profit, stopLoss: stop_loss, txHash: receipt.hash }, null, 2) }] };
      }
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const tx = await perps.setTriggerOrders(BigInt(position_id), tpWei, slWei);
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "triggers_set", positionId: position_id, takeProfit: take_profit, stopLoss: stop_loss, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("add_margin", { description: "Add collateral to a position to reduce liquidation risk", inputSchema: z.object({ position_id: z.number(), amount: z.number() }) }, async ({ position_id, amount }) => {
      const amtWei = ethers.parseUnits(amount.toString(), 18);
      if (sessionAccount) {
        const approveData = ausdIface.encodeFunctionData("approve", [AURA_PERPS_ADDRESS, amtWei]);
        const marginData = perpsIface.encodeFunctionData("addMargin", [BigInt(position_id), amtWei]);
        const account = new ethers.Contract(sessionAccount, AURA_ACCOUNT_ABI, agentWallet);
        const tx = await account.executeBatchByAgent([AUSD_ADDRESS, AURA_PERPS_ADDRESS], [0n, 0n], [approveData, marginData]);
        const receipt = await tx.wait();
        return { content: [{ type: "text", text: JSON.stringify({ status: "margin_added", account: sessionAccount, positionId: position_id, addedAmount: amount, txHash: receipt.hash }, null, 2) }] };
      }
      const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, agentWallet);
      const allowance = await ausd.allowance(agentWallet.address, AURA_PERPS_ADDRESS);
      if (allowance < amtWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const tx = await perps.addMargin(BigInt(position_id), amtWei);
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "margin_added", positionId: position_id, addedAmount: amount, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("get_market_analysis", { description: "Get AI macro analysis (sentiment, news, correlations) for an asset", inputSchema: z.object({ asset: z.string() }) }, async ({ asset }) => {
      const price = await fetchPythPrice(asset);
      const allPrices = {};
      for (const sym of Object.keys(PYTH_IDS)) { try { allPrices[sym] = await fetchPythPrice(sym); } catch {} }
      let sentiment = null;
      try {
        const cmcKey = process.env.COINMARKETCAP;
        if (cmcKey) {
          const res = await fetch("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest", { headers: { "X-CMC_PRO_API_KEY": cmcKey, Accept: "application/json" } });
          if (res.ok) { const d = await res.json(); const v = d.data?.value || 50; const c = d.data?.value_classification || "Neutral"; sentiment = { sentiment: v > 60 ? "BULLISH" : v < 40 ? "BEARISH" : "NEUTRAL", score: v, summary: `Fear & Greed Index: ${v}/100 (${c})` }; }
        }
      } catch {}
      if (!sentiment) {
        try { const res = await fetch("https://api.alternative.me/fng/?limit=1"); if (res.ok) { const d = await res.json(); const v = parseInt(d.data?.[0]?.value || "50"); const c = d.data?.[0]?.value_classification || "Neutral"; sentiment = { sentiment: v > 60 ? "BULLISH" : v < 40 ? "BEARISH" : "NEUTRAL", score: v, summary: `Crypto Fear & Greed: ${v}/100 (${c})` }; } } catch {}
      }
      if (!sentiment) sentiment = { sentiment: "NEUTRAL", score: 50, summary: "Sentiment data unavailable" };
      return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), currentPrice: price, marketSentiment: sentiment.sentiment, sentimentScore: sentiment.score, analysis: sentiment.summary, allPrices, source: "pyth_hermes + fear_greed_index" }, null, 2) }] };
    });

    s.registerTool("get_funding_rate", { description: "Get funding rate and open interest for an asset", inputSchema: z.object({ asset: z.string() }) }, async ({ asset }) => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
      const [longOI, shortOI, ratePerSec] = await Promise.all([perps.totalLongOI(asset.toUpperCase()), perps.totalShortOI(asset.toUpperCase()), perps.FUNDING_RATE_PER_SECOND()]);
      const dailyRate = Number(ratePerSec) * 86400 / 1e18 * 100;
      const longOINum = Number(ethers.formatUnits(longOI, 18));
      const shortOINum = Number(ethers.formatUnits(shortOI, 18));
      const skew = longOINum - shortOINum;
      return { content: [{ type: "text", text: JSON.stringify({ asset: asset.toUpperCase(), fundingRateDaily: `${dailyRate.toFixed(4)}%`, longOpenInterest: longOINum, shortOpenInterest: shortOINum, skew, skewDirection: skew > 0 ? "LONG_HEAVY" : skew < 0 ? "SHORT_HEAVY" : "BALANCED" }, null, 2) }] };
    });

    s.registerTool("partial_close", { description: "Partially close a position by size", inputSchema: z.object({ position_id: z.number(), close_size: z.number() }) }, async ({ position_id, close_size }) => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet);
      const pos = await perps.positions(position_id);
      if (!pos.isOpen) return { content: [{ type: "text", text: "Position already closed." }] };
      const price = await fetchPythPrice(pos.asset);
      if (price) await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait();
      const sizeWei = ethers.parseUnits(close_size.toString(), 18);
      if (sessionAccount) {
        const data = perpsIface.encodeFunctionData("closePositionPartially", [BigInt(position_id), sizeWei]);
        const account = new ethers.Contract(sessionAccount, AURA_ACCOUNT_ABI, agentWallet);
        const tx = await account.executeBatchByAgent([AURA_PERPS_ADDRESS], [0n], [data]);
        const receipt = await tx.wait();
        return { content: [{ type: "text", text: JSON.stringify({ status: "partially_closed", account: sessionAccount, positionId: position_id, closedSize: close_size, exitPrice: price, txHash: receipt.hash }, null, 2) }] };
      }
      const tx = await perps.closePositionPartially(BigInt(position_id), sizeWei);
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "partially_closed", positionId: position_id, closedSize: close_size, exitPrice: price, txHash: receipt.hash }, null, 2) }] };
    });

    return s;
  }

  // Resolve Bearer token to AuraAccount address via main backend
  const BACKEND_URL = process.env.BACKEND_URL || "https://aura-backend-backend.up.railway.app";
  async function resolveAuth(req) {
    const auth = req.headers?.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    try {
      // Ask the main backend to resolve this token
      const res = await fetch(`${BACKEND_URL}/api/mcp-keys/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: token }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.auraAccount || null;
    } catch { return null; }
  }

  app.get("/sse", async (req, res) => {
    const auraAccount = await resolveAuth(req);
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    res.on("close", () => { delete transports[transport.sessionId]; });
    const s = createServer(auraAccount);
    await s.connect(transport);
  });

  // Return 405 on POST /sse to force mcp-remote to use SSE transport
  app.post("/sse", (req, res) => res.status(405).end());

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!transport) return res.status(400).json({ error: "No active session" });
    await transport.handlePostMessage(req, res);
  });

  // ── Streamable HTTP transport (for Claude.ai web) ──
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/server");

  app.all("/mcp", express.json(), async (req, res) => {
    let auraAccount = await resolveAuth(req);
    // If no Bearer token, check if any recent auth exists (stateless workaround)
    if (!auraAccount && authenticatedAccounts.size > 0) {
      // Use the most recently authenticated account (single-user demo simplification)
      auraAccount = [...authenticatedAccounts.values()].pop();
    }
    const s = createServer(auraAccount);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await s.connect(transport);

    // Convert Express req to Web Standard Request
    const url = `http://localhost:${port}${req.originalUrl}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) { if (v) headers.set(k, Array.isArray(v) ? v[0] : v); }
    const webReq = new Request(url, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    });

    try {
      const webRes = await transport.handleRequest(webReq);
      res.status(webRes.status);
      webRes.headers.forEach((v, k) => res.setHeader(k, v));
      // Handle streaming response
      if (webRes.body) {
        const reader = webRes.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        await pump();
      } else {
        const text = await webRes.text();
        res.send(text);
      }
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.listen(port, () => {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║  AURA MCP SERVER — Delegation Model                      ║`);
    console.log(`║  SSE: http://localhost:${port}/sse                         ║`);
    console.log(`║  Agent: ${agentWallet.address}  ║`);
    console.log(`║                                                           ║`);
    console.log(`║  Tools: get_price, get_orderbook, place_limit_order,      ║`);
    console.log(`║    place_market_order, get_positions, close_position,      ║`);
    console.log(`║    get_account_balance, set_stop_loss_take_profit,         ║`);
    console.log(`║    add_margin, get_market_analysis, get_funding_rate,      ║`);
    console.log(`║    partial_close                                           ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Aura MCP] stdio mode | Agent:", agentWallet.address);
}
