// backend/socialTrading.js
// Social Trading API — reads AuraSocialTrading on-chain state
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

function formatStrategy(id, s) {
  return {
    id: Number(id),
    strategist: s.strategist,
    name: s.name,
    description: s.description,
    performanceFeeBps: Number(s.performanceFeeBps),
    isActive: s.isActive,
    totalFollowerCapital: ethers.formatEther(s.totalFollowerCapital),
    followerCount: Number(s.followerCount),
    totalPnl: ethers.formatEther(s.totalPnl),
    createdAt: Number(s.createdAt),
  };
}

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

module.exports = { getStrategies, getStrategyById, getFollowerPosition };
