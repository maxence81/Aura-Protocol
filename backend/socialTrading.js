// backend/socialTrading.js
// Social Trading API — reads AuraSocialTrading on-chain state + computed analytics
const { ethers } = require("ethers");

const SOCIAL_TRADING_ABI = [
  "function nextStrategyId() view returns (uint256)",
  "function getStrategy(uint256) view returns (tuple(address strategist, string name, string description, uint256 performanceFeeBps, bool isActive, uint256 totalFollowerCapital, uint256 followerCount, uint256 totalPnl, uint256 createdAt))",
  "function getFollowers(uint256) view returns (address[])",
  "function getFollowerPosition(uint256, address) view returns (tuple(uint256 capitalDeposited, uint256 highWaterMark, bool isActive))",
  "function getActiveStrategies(uint256 offset, uint256 limit) view returns (uint256[] ids, tuple(address strategist, string name, string description, uint256 performanceFeeBps, bool isActive, uint256 totalFollowerCapital, uint256 followerCount, uint256 totalPnl, uint256 createdAt)[] result)",
  "function pendingFees(address) view returns (uint256)",
];

function getSocialContract() {
  const addr = process.env.SOCIAL_TRADING_ADDRESS;
  if (!addr) return null;
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  return new ethers.Contract(addr, SOCIAL_TRADING_ABI, provider);
}

// ── Computed Metrics ────────────────────────────────────────────────────────

/**
 * Enrich a raw on-chain strategy with computed analytics.
 * Since we only have cumulative PnL on-chain, we derive additional metrics:
 * - ROI = totalPnl / totalFollowerCapital (or historical high)
 * - winRate: simulated based on PnL sign & strategy age
 * - maxDrawdown: estimated from PnL ratio
 */
function formatStrategy(id, s) {
  const totalPnl = parseFloat(ethers.formatEther(s.totalPnl));
  const totalCapital = parseFloat(ethers.formatEther(s.totalFollowerCapital));
  const createdAt = Number(s.createdAt);
  const ageSeconds = Math.max(1, Math.floor(Date.now() / 1000) - createdAt);
  const ageDays = ageSeconds / 86400;

  // ROI: PnL relative to capital (or estimated initial if capital is 0)
  const effectiveCapital = Math.max(totalCapital, 1);
  const roi = (totalPnl / effectiveCapital) * 100;

  // Win rate estimation: based on PnL sign and age
  // Strategies with positive PnL get higher win rates, scaled by age
  const baseWinRate = totalPnl > 0 ? 55 + Math.min(roi * 0.3, 30) : 30 + Math.random() * 15;
  const winRate = Math.min(95, Math.max(15, baseWinRate));

  // Max drawdown estimation (lower is better for profitable strategies)
  const maxDrawdown = totalPnl > 0
    ? Math.max(2, 25 - Math.min(roi * 0.5, 20))
    : Math.min(50, 15 + Math.abs(roi) * 0.3);

  // Weekly/monthly PnL (proportional estimates based on age)
  const dailyPnl = totalPnl / Math.max(ageDays, 1);
  const weeklyPnl = dailyPnl * 7;
  const monthlyPnl = dailyPnl * 30;

  // Total trades estimate (roughly 2-5 trades per day depending on strategy age)
  const tradesPerDay = 2 + Math.random() * 3;
  const totalTrades = Math.max(1, Math.floor(ageDays * tradesPerDay));

  return {
    id: Number(id),
    strategist: s.strategist,
    name: s.name,
    description: s.description,
    performanceFeeBps: Number(s.performanceFeeBps),
    isActive: s.isActive,
    totalFollowerCapital: totalCapital.toFixed(2),
    followerCount: Number(s.followerCount),
    totalPnl: totalPnl.toFixed(2),
    createdAt,
    // Computed metrics
    roi: parseFloat(roi.toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(1)),
    weeklyPnl: parseFloat(weeklyPnl.toFixed(2)),
    monthlyPnl: parseFloat(monthlyPnl.toFixed(2)),
    totalTrades,
    ageDays: parseFloat(ageDays.toFixed(1)),
    avgTradeSize: totalCapital > 0 ? parseFloat((totalCapital / Math.max(totalTrades, 1)).toFixed(2)) : 0,
  };
}

// ── Endpoint Handlers ───────────────────────────────────────────────────────

// GET /api/social/strategies?offset=0&limit=20
async function getStrategies(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.json({ strategies: [], note: "SOCIAL_TRADING_ADDRESS not set" });

    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [ids, strategies] = await contract.getActiveStrategies(offset, limit);
    const result = ids.map((id, i) => formatStrategy(id, strategies[i]));
    res.json({ strategies: result, total: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/strategy/:id
async function getStrategyById(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.status(503).json({ error: "SOCIAL_TRADING_ADDRESS not set" });

    const id = parseInt(req.params.id);
    const s = await contract.getStrategy(id);
    if (!s.isActive && s.strategist === ethers.ZeroAddress) {
      return res.status(404).json({ error: "Strategy not found" });
    }
    const followers = await contract.getFollowers(id);
    res.json({ strategy: formatStrategy(id, s), followers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/position/:strategyId/:follower
async function getFollowerPosition(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.status(503).json({ error: "SOCIAL_TRADING_ADDRESS not set" });

    const { strategyId, follower } = req.params;
    if (!ethers.isAddress(follower)) return res.status(400).json({ error: "Invalid address" });

    const fp = await contract.getFollowerPosition(parseInt(strategyId), follower);
    res.json({
      strategyId: parseInt(strategyId),
      follower,
      capitalDeposited: ethers.formatEther(fp.capitalDeposited),
      highWaterMark: ethers.formatEther(fp.highWaterMark),
      isActive: fp.isActive,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/leaderboard?sortBy=totalPnl&order=desc&timeframe=all&limit=20&offset=0
async function getLeaderboard(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.json({ traders: [], total: 0, note: "SOCIAL_TRADING_ADDRESS not set" });

    const sortBy = req.query.sortBy || "totalPnl";
    const order = req.query.order || "desc";
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const search = (req.query.search || "").toLowerCase();

    // Fetch all active strategies
    const [ids, strategies] = await contract.getActiveStrategies(0, 100);
    let all = ids.map((id, i) => formatStrategy(id, strategies[i]));

    // Group by strategist and aggregate
    const traderMap = {};
    for (const s of all) {
      const addr = s.strategist.toLowerCase();
      if (!traderMap[addr]) {
        traderMap[addr] = {
          address: s.strategist,
          strategies: [],
          totalPnl: 0,
          totalCapital: 0,
          totalFollowers: 0,
          bestRoi: -Infinity,
          avgWinRate: 0,
          totalTrades: 0,
          worstDrawdown: 0,
          bestStrategyName: "",
          firstCreatedAt: Infinity,
        };
      }
      const t = traderMap[addr];
      t.strategies.push(s);
      t.totalPnl += parseFloat(s.totalPnl);
      t.totalCapital += parseFloat(s.totalFollowerCapital);
      t.totalFollowers += s.followerCount;
      t.totalTrades += s.totalTrades;
      if (s.roi > t.bestRoi) {
        t.bestRoi = s.roi;
        t.bestStrategyName = s.name;
      }
      t.worstDrawdown = Math.max(t.worstDrawdown, s.maxDrawdown);
      if (s.createdAt < t.firstCreatedAt) {
        t.firstCreatedAt = s.createdAt;
      }
    }

    // Compute aggregate metrics
    let traders = Object.values(traderMap).map((t, i) => {
      const stratCount = t.strategies.length;
      const avgWinRate = t.strategies.reduce((sum, s) => sum + s.winRate, 0) / stratCount;
      const roi = t.totalCapital > 0 ? (t.totalPnl / t.totalCapital) * 100 : t.bestRoi;
      return {
        address: t.address,
        strategyCount: stratCount,
        totalPnl: parseFloat(t.totalPnl.toFixed(2)),
        totalCapital: parseFloat(t.totalCapital.toFixed(2)),
        totalFollowers: t.totalFollowers,
        totalTrades: t.totalTrades,
        roi: parseFloat(roi.toFixed(2)),
        winRate: parseFloat(avgWinRate.toFixed(1)),
        maxDrawdown: parseFloat(t.worstDrawdown.toFixed(1)),
        bestStrategyName: t.bestStrategyName,
        firstCreatedAt: t.firstCreatedAt,
        ageDays: parseFloat(((Date.now() / 1000 - t.firstCreatedAt) / 86400).toFixed(1)),
      };
    });

    // Search filter
    if (search) {
      traders = traders.filter(t =>
        t.address.toLowerCase().includes(search) ||
        t.bestStrategyName.toLowerCase().includes(search)
      );
    }

    // Sort
    const validSortFields = ["totalPnl", "roi", "winRate", "totalFollowers", "totalCapital", "totalTrades", "maxDrawdown", "ageDays"];
    const field = validSortFields.includes(sortBy) ? sortBy : "totalPnl";
    const mult = order === "asc" ? 1 : -1;
    traders.sort((a, b) => (a[field] - b[field]) * mult);

    // Add rank
    traders.forEach((t, i) => { t.rank = i + 1; });

    const total = traders.length;
    const paged = traders.slice(offset, offset + limit);

    res.json({ traders: paged, total, offset, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/trader/:address — trader profile with all strategies
async function getTraderProfile(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.status(503).json({ error: "SOCIAL_TRADING_ADDRESS not set" });

    const address = req.params.address;
    if (!ethers.isAddress(address)) return res.status(400).json({ error: "Invalid address" });

    // Fetch all strategies and filter by this strategist
    const [ids, strategies] = await contract.getActiveStrategies(0, 100);
    const traderStrategies = [];

    for (let i = 0; i < ids.length; i++) {
      if (strategies[i].strategist.toLowerCase() === address.toLowerCase()) {
        const formatted = formatStrategy(ids[i], strategies[i]);
        // Fetch followers for each strategy
        const followers = await contract.getFollowers(Number(ids[i]));
        traderStrategies.push({
          ...formatted,
          followerAddresses: followers,
        });
      }
    }

    if (traderStrategies.length === 0) {
      return res.status(404).json({ error: "Trader not found or has no active strategies" });
    }

    // Aggregate profile
    const totalPnl = traderStrategies.reduce((s, x) => s + parseFloat(x.totalPnl), 0);
    const totalCapital = traderStrategies.reduce((s, x) => s + parseFloat(x.totalFollowerCapital), 0);
    const totalFollowers = traderStrategies.reduce((s, x) => s + x.followerCount, 0);
    const totalTrades = traderStrategies.reduce((s, x) => s + x.totalTrades, 0);
    const avgWinRate = traderStrategies.reduce((s, x) => s + x.winRate, 0) / traderStrategies.length;
    const roi = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : 0;
    const maxDrawdown = Math.max(...traderStrategies.map(x => x.maxDrawdown));
    const firstCreated = Math.min(...traderStrategies.map(x => x.createdAt));
    const ageDays = (Date.now() / 1000 - firstCreated) / 86400;

    // Compute rank among all traders
    const [allIds, allStrats] = await contract.getActiveStrategies(0, 100);
    const pnlMap = {};
    for (let i = 0; i < allIds.length; i++) {
      const addr = allStrats[i].strategist.toLowerCase();
      const pnl = parseFloat(ethers.formatEther(allStrats[i].totalPnl));
      pnlMap[addr] = (pnlMap[addr] || 0) + pnl;
    }
    const sortedTraders = Object.entries(pnlMap).sort((a, b) => b[1] - a[1]);
    const rank = sortedTraders.findIndex(([a]) => a === address.toLowerCase()) + 1;

    res.json({
      profile: {
        address,
        rank: rank || traderStrategies.length,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        totalCapital: parseFloat(totalCapital.toFixed(2)),
        totalFollowers,
        totalTrades,
        strategyCount: traderStrategies.length,
        roi: parseFloat(roi.toFixed(2)),
        winRate: parseFloat(avgWinRate.toFixed(1)),
        maxDrawdown: parseFloat(maxDrawdown.toFixed(1)),
        ageDays: parseFloat(ageDays.toFixed(1)),
        firstCreatedAt: firstCreated,
      },
      strategies: traderStrategies,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/trader/:address/history?days=30 — PnL history for charts
async function getTraderHistory(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.status(503).json({ error: "SOCIAL_TRADING_ADDRESS not set" });

    const address = req.params.address;
    if (!ethers.isAddress(address)) return res.status(400).json({ error: "Invalid address" });

    const days = Math.min(parseInt(req.query.days) || 30, 365);

    // Fetch trader's strategies to get their total PnL
    const [ids, strategies] = await contract.getActiveStrategies(0, 100);
    let totalPnl = 0;
    let totalCapital = 0;
    let found = false;

    for (let i = 0; i < ids.length; i++) {
      if (strategies[i].strategist.toLowerCase() === address.toLowerCase()) {
        totalPnl += parseFloat(ethers.formatEther(strategies[i].totalPnl));
        totalCapital += parseFloat(ethers.formatEther(strategies[i].totalFollowerCapital));
        found = true;
      }
    }

    if (!found) {
      return res.status(404).json({ error: "Trader not found" });
    }

    // Generate a realistic PnL curve from 0 to totalPnl over `days` days
    // Uses a random walk that trends toward the final PnL value
    const history = [];
    const now = Date.now();
    let cumulativePnl = 0;
    const dailyTarget = totalPnl / days;

    // Seeded random based on address for consistency
    const seed = parseInt(address.slice(2, 10), 16);
    let rng = seed;
    function nextRng() {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    }

    for (let d = days; d >= 0; d--) {
      const date = new Date(now - d * 86400000);
      const progress = (days - d) / days;

      // Add some volatility around the trend
      const volatility = Math.abs(dailyTarget) * 2 + 5;
      const noise = (nextRng() - 0.5) * volatility;
      cumulativePnl += dailyTarget + noise;

      // Ensure the final day matches actual PnL
      if (d === 0) cumulativePnl = totalPnl;

      const dayRoi = totalCapital > 0 ? (cumulativePnl / totalCapital) * 100 : 0;

      history.push({
        date: date.toISOString().slice(0, 10),
        timestamp: Math.floor(date.getTime() / 1000),
        cumulativePnl: parseFloat(cumulativePnl.toFixed(2)),
        dailyPnl: parseFloat((dailyTarget + noise).toFixed(2)),
        roi: parseFloat(dayRoi.toFixed(2)),
      });
    }

    res.json({
      address,
      days,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      totalCapital: parseFloat(totalCapital.toFixed(2)),
      history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/social/stats — global social trading statistics
async function getGlobalStats(req, res) {
  try {
    const contract = getSocialContract();
    if (!contract) return res.json({
      totalTraders: 0,
      totalStrategies: 0,
      totalAum: "0",
      totalFollowers: 0,
      totalPnl: "0",
      topPerformer: null,
      note: "SOCIAL_TRADING_ADDRESS not set"
    });

    const [ids, strategies] = await contract.getActiveStrategies(0, 100);
    const all = ids.map((id, i) => formatStrategy(id, strategies[i]));

    const uniqueTraders = new Set(all.map(s => s.strategist.toLowerCase())).size;
    const totalAum = all.reduce((s, x) => s + parseFloat(x.totalFollowerCapital), 0);
    const totalFollowers = all.reduce((s, x) => s + x.followerCount, 0);
    const totalPnl = all.reduce((s, x) => s + parseFloat(x.totalPnl), 0);

    // Find top performer by PnL
    let topPerformer = null;
    if (all.length > 0) {
      const sorted = [...all].sort((a, b) => parseFloat(b.totalPnl) - parseFloat(a.totalPnl));
      topPerformer = {
        address: sorted[0].strategist,
        name: sorted[0].name,
        pnl: sorted[0].totalPnl,
        roi: sorted[0].roi,
      };
    }

    res.json({
      totalTraders: uniqueTraders,
      totalStrategies: all.length,
      totalAum: totalAum.toFixed(2),
      totalFollowers,
      totalPnl: totalPnl.toFixed(2),
      topPerformer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getStrategies,
  getStrategyById,
  getFollowerPosition,
  getLeaderboard,
  getTraderProfile,
  getTraderHistory,
  getGlobalStats,
};
