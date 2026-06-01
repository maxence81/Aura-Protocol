"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Users, TrendingUp, Copy, Star, RefreshCw } from "lucide-react";
import { ConnectButton, useActiveAccount } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import { defineChain } from "thirdweb";
import { client } from "../client";
import { API_URL } from "../../lib/config";

const robinhoodChain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
});

const wallets = [
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
];

type Strategy = {
  id: number;
  strategist: string;
  name: string;
  description: string;
  performanceFeeBps: number;
  totalFollowerCapital: string;
  followerCount: number;
  totalPnl: string;
  isActive: boolean;
};

function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}

function PnlBadge({ pnl }: { pnl: string }) {
  const val = parseFloat(pnl);
  const color = val > 0 ? "text-green-400" : val < 0 ? "text-red-400" : "text-gray-400";
  return <span className={`font-mono font-bold ${color}`}>{val >= 0 ? "+" : ""}{val.toFixed(2)} aUSD</span>;
}

export default function SocialPage() {
  const account = useActiveAccount();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [followModal, setFollowModal] = useState<Strategy | null>(null);
  const [followAmount, setFollowAmount] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const fetchStrategies = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch(`${API_URL}/api/social/strategies?limit=20`);
      const data = await res.json();
      setStrategies(data.strategies || []);
    } catch {
      // backend not running or contract not deployed — show empty state
      setStrategies([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStrategies();
    const interval = setInterval(fetchStrategies, 15000);
    return () => clearInterval(interval);
  }, [fetchStrategies]);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Copy size={20} className="text-purple-400" />
              Social Trading
            </h1>
            <p className="text-xs text-gray-500">Copy top strategists on-chain · Robinhood Chain</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchStrategies}
            disabled={refreshing}
            className="p-2 rounded-lg border border-white/10 hover:border-white/30 transition-colors"
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin text-purple-400" : "text-gray-400"} />
          </button>
          <ConnectButton client={client} wallets={wallets} chain={robinhoodChain} />
        </div>
      </div>

      {/* Stats bar */}
      <div className="border-b border-white/10 px-6 py-3 flex gap-8 text-sm">
        <div>
          <span className="text-gray-500">Active Strategies</span>
          <span className="ml-2 font-bold text-white">{strategies.length}</span>
        </div>
        <div>
          <span className="text-gray-500">Total Capital</span>
          <span className="ml-2 font-bold text-purple-400">
            {strategies.reduce((s, x) => s + parseFloat(x.totalFollowerCapital), 0).toFixed(2)} aUSD
          </span>
        </div>
        <div>
          <span className="text-gray-500">Total Followers</span>
          <span className="ml-2 font-bold text-white">
            {strategies.reduce((s, x) => s + x.followerCount, 0)}
          </span>
        </div>
      </div>

      {/* Leaderboard */}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-gray-500">
            <RefreshCw size={24} className="animate-spin mr-3" /> Loading strategies…
          </div>
        ) : strategies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-500 gap-3">
            <Copy size={40} className="opacity-30" />
            <p>No active strategies yet.</p>
            <p className="text-xs">Deploy AuraSocialTrading and publish a strategy to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {strategies.map((s, i) => (
              <motion.div
                key={s.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="border border-white/10 rounded-xl p-5 hover:border-purple-500/40 transition-colors bg-white/[0.02]"
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Rank + info */}
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 font-bold text-sm shrink-0">
                      {i + 1}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white">{s.name}</h3>
                        {i === 0 && <Star size={14} className="text-yellow-400 fill-yellow-400" />}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                      <p className="text-xs text-gray-600 mt-1 font-mono">{shortAddr(s.strategist)}</p>
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="flex items-center gap-6 text-sm shrink-0">
                    <div className="text-center">
                      <div className="text-gray-500 text-xs mb-1 flex items-center gap-1">
                        <TrendingUp size={11} /> PnL
                      </div>
                      <PnlBadge pnl={s.totalPnl} />
                    </div>
                    <div className="text-center">
                      <div className="text-gray-500 text-xs mb-1 flex items-center gap-1">
                        <Users size={11} /> Followers
                      </div>
                      <span className="font-bold">{s.followerCount}</span>
                    </div>
                    <div className="text-center">
                      <div className="text-gray-500 text-xs mb-1">AUM</div>
                      <span className="font-mono text-purple-300">{parseFloat(s.totalFollowerCapital).toFixed(0)} aUSD</span>
                    </div>
                    <div className="text-center">
                      <div className="text-gray-500 text-xs mb-1">Fee</div>
                      <span className="text-yellow-400">{(s.performanceFeeBps / 100).toFixed(0)}%</span>
                    </div>
                    <button
                      onClick={() => { setFollowModal(s); setFollowAmount(""); }}
                      disabled={!account}
                      className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
                    >
                      Follow
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Follow Modal */}
      {followModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#0f0f0f] border border-white/20 rounded-2xl p-6 w-full max-w-md"
          >
            <h2 className="text-lg font-bold mb-1">Follow Strategy</h2>
            <p className="text-gray-400 text-sm mb-4">
              <span className="text-white font-semibold">{followModal.name}</span> · {(followModal.performanceFeeBps / 100).toFixed(0)}% performance fee
            </p>
            <div className="mb-4">
              <label className="text-xs text-gray-500 mb-1 block">Amount to allocate (aUSD)</label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 100"
                value={followAmount}
                onChange={(e) => setFollowAmount(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-purple-500"
              />
            </div>
            <p className="text-xs text-gray-600 mb-5">
              Your capital will be tracked on-chain. You can unfollow and withdraw at any time.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setFollowModal(null)}
                className="flex-1 py-3 rounded-lg border border-white/10 hover:border-white/30 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={!followAmount || parseFloat(followAmount) <= 0}
                className="flex-1 py-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed font-semibold transition-colors"
                onClick={() => {
                  // In production: call social.follow(strategyId, parseEther(followAmount))
                  // via thirdweb sendTransaction. For now, show confirmation.
                  alert(`To follow: call AuraSocialTrading.follow(${followModal.id}, ${followAmount} aUSD)\nContract interaction requires thirdweb sendTransaction integration.`);
                  setFollowModal(null);
                }}
              >
                Confirm Follow
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
