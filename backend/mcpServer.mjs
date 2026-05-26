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
  "function positions(uint256 positionId) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
  "function nextPositionId() view returns (uint256)",
  "function calculatePnL(uint256 positionId, uint256 currentPrice) view returns (uint256 pnl, bool isProfit)",
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

// ── Start ──
const args = process.argv.slice(2);

if (args.includes("--http")) {
  const port = parseInt(args[args.indexOf("--http") + 1]) || 3002;
  const express = (await import("express")).default;
  const cors = (await import("cors")).default;

  const app = express();
  app.use(cors());

  const transports = {};

  // Factory: create a fresh McpServer per SSE session (McpServer only supports 1 connection)
  function createServer() {
    const s = new McpServer({ name: "aura-perps", version: "1.0.0" });

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
      const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, agentWallet);
      const allowance = await ausd.allowance(agentWallet.address, AURA_PERPS_ADDRESS);
      if (allowance < colWei) await (await ausd.approve(AURA_PERPS_ADDRESS, ethers.MaxUint256)).wait();
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const tx = await perps.openPosition(asset.toUpperCase(), is_long, colWei, BigInt(leverage));
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "opened", asset: asset.toUpperCase(), side: is_long ? "LONG" : "SHORT", collateral, leverage, entryPrice: price, txHash: receipt.hash }, null, 2) }] };
    });

    s.registerTool("get_positions", { description: "Get open positions from AuraPerps", inputSchema: z.object({}) }, async () => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, robinhoodProvider);
      const nextId = Number(await perps.nextPositionId());
      const positions = [];
      for (let i = 0; i < nextId && positions.length < 20; i++) { try { const pos = await perps.positions(i); if (pos.isOpen) { const price = await fetchPythPrice(pos.asset); positions.push({ id: i, asset: pos.asset, side: pos.isLong ? "LONG" : "SHORT", collateral: Number(ethers.formatUnits(pos.collateralAmount, 18)), leverage: Number(pos.leverage), entryPrice: Number(ethers.formatUnits(pos.entryPrice, 18)), currentPrice: price }); } } catch { continue; } }
      return { content: [{ type: "text", text: JSON.stringify({ positions, count: positions.length }, null, 2) }] };
    });

    s.registerTool("close_position", { description: "Close a position by ID", inputSchema: z.object({ position_id: z.number() }) }, async ({ position_id }) => {
      const perps = new ethers.Contract(AURA_PERPS_ADDRESS, PERPS_ABI, agentWallet);
      const pos = await perps.positions(position_id);
      if (!pos.isOpen) return { content: [{ type: "text", text: "Already closed." }] };
      const price = await fetchPythPrice(pos.asset);
      if (price) { const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, ORACLE_ABI, agentWallet); await (await oracle.setPrice(pos.asset, ethers.parseUnits(price.toFixed(2), 18))).wait(); }
      const tx = await perps.closePosition(position_id);
      const receipt = await tx.wait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "closed", positionId: position_id, asset: pos.asset, exitPrice: price, txHash: receipt.hash }, null, 2) }] };
    });

    return s;
  }

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    res.on("close", () => { delete transports[transport.sessionId]; });
    const s = createServer();
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
    const s = createServer();
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
    console.log(`║         place_market_order, get_positions, close_position  ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Aura MCP] stdio mode | Agent:", agentWallet.address);
}
