/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║         AURA MCP SERVER — AI-to-Perps Trading Interface          ║
 * ║   Any MCP-compatible AI (Claude, GPT, etc.) can connect and      ║
 * ║   trade on the Stylus LOB + AuraPerps with their own wallet.     ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Auth model:
 *   - HTTP mode: Bearer token in Authorization header → resolves to user wallet
 *   - stdio mode: uses PRIVATE_KEY from .env (single-user / demo)
 *
 * Register users: node mcp-register.mjs
 *
 * Usage:
 *   node mcpServer.mjs              (stdio — Claude Desktop, Cursor, Kiro)
 *   node mcpServer.mjs --http 3002  (HTTP — remote AI agents with per-user auth)
 */

import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { z } from "zod";
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { resolveApiKey } from "./mcp-users.mjs";

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

// ── Providers ──
const sepoliaProvider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
const robinhoodProvider = new ethers.JsonRpcProvider(ROBINHOOD_RPC);

// ── Default wallets (stdio mode / fallback) ──
const defaultSepoliaWallet = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);
const defaultRobinhoodWallet = new ethers.Wallet(PRIVATE_KEY, robinhoodProvider);

// ── Per-request wallet resolution ──
// In HTTP mode, the Bearer token resolves to a user-specific wallet.
// We use AsyncLocalStorage to pass the wallet through tool calls.
import { AsyncLocalStorage } from "async_hooks";
const requestContext = new AsyncLocalStorage();

function getWallets() {
  const ctx = requestContext.getStore();
  if (ctx?.sepoliaWallet) return ctx;
  return { sepoliaWallet: defaultSepoliaWallet, robinhoodWallet: defaultRobinhoodWallet };
}

// ── ABIs ──
const STYLUS_LOB_ABI = [
  "function store_order(address owner, uint256 asset_hash, bool is_long, uint256 collateral, uint256 leverage, uint256 limit_price) returns (uint256)",
  "function get_active_orders_sorted(uint256 asset_hash, bool is_long, uint256 max_results) view returns (uint256[] ids, uint256[] prices, uint256[] sizes)",
  "function get_book_depth(uint256 asset_hash) view returns (uint256, uint256)",
];

const PERPS_ABI = [
  "function openPosition(string asset, bool isLong, uint256 collateralAmount, uint256 leverage) returns (uint256)",
  "function closePosition(uint256 positionId) external",
  "function positions(uint256 positionId) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
  "function nextPositionId() view returns (uint256)",
  "function calculatePnL(uint256 positionId, uint256 currentPrice) view returns (uint256 pnl, bool isProfit)",
];

const AUSD_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ORACLE_ABI = ["function setPrice(string asset, uint256 price) external"];

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
  description: "Place a limit order on the Stylus WASM order book (Arbitrum Sepolia). Uses YOUR wallet to sign.",
  inputSchema: z.object({
    asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA"),
    is_long: z.boolean().describe("true=long/buy, false=short/sell"),
    collateral: z.number().describe("Collateral in USD (e.g. 100)"),
    leverage: z.number().min(1).max(50).describe("Leverage 1-50x"),
    limit_price: z.number().describe("Limit price in USD"),
  }),
}, async ({ asset, is_long, collateral, leverage, limit_price }) => {
  const { sepoliaWallet } = getWallets();
  const lob = new ethers.Contract(STYLUS_LOB_ADDRESS, STYLUS_LOB_ABI, sepoliaWallet);
  const hash = assetHash(asset);
  const colWei = ethers.parseUnits(collateral.toString(), 18);
  const priceWei = ethers.parseUnits(limit_price.toString(), 18);
  const tx = await lob.store_order(sepoliaWallet.address, hash, is_long, colWei, BigInt(leverage), priceWei);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "placed", wallet: sepoliaWallet.address,
    asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT",
    collateral, leverage, limit_price, chain: "Arbitrum Sepolia", txHash: receipt.hash,
  }, null, 2) }] };
});

server.registerTool("place_market_order", {
  description: "Open a perpetual position at market price on AuraPerps (Robinhood Chain). Uses YOUR wallet.",
  inputSchema: z.object({
    asset: z.string().describe("Asset symbol e.g. BTC, ETH, TSLA"),
    is_long: z.boolean().describe("true=long, false=short"),
    collateral: z.number().describe("Collateral in aUSD (e.g. 100)"),
    leverage: z.number().min(1).max(50).describe("Leverage 1-50x"),
  }),
}, async ({ asset, is_long, collateral, leverage }) => {
  const { robinhoodWallet } = getWallets();
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodWallet);
  const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, robinhoodWallet);
  const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, robinhoodWallet);
  const colWei = ethers.parseUnits(collateral.toString(), 18);

  const price = await fetchPythPrice(asset);
  if (price) await (await oracle.setPrice(asset.toUpperCase(), ethers.parseUnits(price.toFixed(2), 18))).wait();

  const allowance = await ausd.allowance(robinhoodWallet.address, AURA_PERPS_ADDRESS);
  if (allowance < colWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();

  const tx = await perps.openPosition(asset.toUpperCase(), is_long, colWei, BigInt(leverage));
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "opened", wallet: robinhoodWallet.address,
    asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT",
    collateral, leverage, entryPrice: price, chain: "Robinhood Chain", txHash: receipt.hash,
  }, null, 2) }] };
});

server.registerTool("get_positions", {
  description: "Get your open perpetual positions from AuraPerps (Robinhood Chain)",
  inputSchema: z.object({}),
}, async () => {
  const { robinhoodWallet } = getWallets();
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
  const targetOwner = robinhoodWallet.address.toLowerCase();
  const nextId = Number(await perps.nextPositionId());
  const positions = [];
  for (let i = 0; i < nextId && positions.length < 20; i++) {
    try {
      const pos = await perps.positions(i);
      if (pos.isOpen && pos.owner.toLowerCase() === targetOwner) {
        const price = await fetchPythPrice(pos.asset);
        let pnl = null, isProfit = null;
        if (price) {
          const [p, ip] = await perps.calculatePnL(i, ethers.parseUnits(price.toFixed(2), 18));
          pnl = Number(ethers.formatUnits(p, 18)); isProfit = ip;
        }
        positions.push({
          id: i, asset: pos.asset, side: pos.isLong ? "LONG" : "SHORT",
          collateral: Number(ethers.formatUnits(pos.collateralAmount, 18)),
          leverage: Number(pos.leverage),
          entryPrice: Number(ethers.formatUnits(pos.entryPrice, 18)),
          size: Number(ethers.formatUnits(pos.positionSize, 18)),
          pnl, isProfit, currentPrice: price,
        });
      }
    } catch { continue; }
  }
  return { content: [{ type: "text", text: JSON.stringify({ wallet: robinhoodWallet.address, positions, count: positions.length }, null, 2) }] };
});

server.registerTool("close_position", {
  description: "Close an open perpetual position on AuraPerps by position ID",
  inputSchema: z.object({ position_id: z.number().describe("Position ID to close") }),
}, async ({ position_id }) => {
  const { robinhoodWallet } = getWallets();
  const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodWallet);
  const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, robinhoodWallet);
  const pos = await perps.positions(position_id);
  if (!pos.isOpen) return { content: [{ type: "text", text: "Position already closed." }] };
  if (pos.owner.toLowerCase() !== robinhoodWallet.address.toLowerCase()) {
    return { content: [{ type: "text", text: "Not your position." }] };
  }
  const price = await fetchPythPrice(pos.asset);
  if (price) await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait();
  const tx = await perps.closePosition(position_id);
  const receipt = await tx.wait();
  return { content: [{ type: "text", text: JSON.stringify({
    status: "closed", positionId: position_id, asset: pos.asset, exitPrice: price, txHash: receipt.hash,
  }, null, 2) }] };
});

// ── Start ──
const args = process.argv.slice(2);

if (args.includes("--http")) {
  const port = parseInt(args[args.indexOf("--http") + 1]) || 3002;
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());

  app.all("/mcp", async (req, res) => {
    // Extract Bearer token and resolve to user wallet
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    let sepoliaWallet = defaultSepoliaWallet;
    let robinhoodWallet = defaultRobinhoodWallet;

    if (token) {
      const privateKey = await resolveApiKey(token);
      if (!privateKey) { return res.status(401).json({ error: "Invalid API key" }); }
      sepoliaWallet = new ethers.Wallet(privateKey, sepoliaProvider);
      robinhoodWallet = new ethers.Wallet(privateKey, robinhoodProvider);
    }

    // Run the MCP request within the user's wallet context
    requestContext.run({ sepoliaWallet, robinhoodWallet }, async () => {
      try {
        // Use stdio-over-HTTP: serialize JSON-RPC request/response
        const body = req.body;
        // Forward to server's internal handler
        const result = await server.handleRequest(body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  app.listen(port, () => {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║  AURA MCP SERVER — Per-User Perp Trading                 ║`);
    console.log(`║  HTTP: http://localhost:${port}/mcp                        ║`);
    console.log(`║                                                           ║`);
    console.log(`║  Auth: Bearer <api_key> (from mcp-register.mjs)          ║`);
    console.log(`║  Each user trades with their own wallet.                  ║`);
    console.log(`║                                                           ║`);
    console.log(`║  Tools: get_price, get_orderbook, place_limit_order,      ║`);
    console.log(`║         place_market_order, get_positions, close_position  ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
  });
} else {
  // Stdio mode — single user from .env PRIVATE_KEY
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Aura MCP] Server running on stdio (wallet:", defaultSepoliaWallet.address, ")");
}
