"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Settings,
  X,
  TrendingUp,
  Activity,
  PlusSquare,
  RefreshCw,
  Wallet,
  Shield,
  Zap,
} from "lucide-react";
import { ConnectButton, useActiveAccount } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import { defineChain, prepareContractCall, sendTransaction, waitForReceipt, getContract } from "thirdweb";
import { client } from "../../client";
import { createPublicClient, http, formatEther, parseEther } from "viem";
import { CONTRACT_ADDRESSES, AURA_COPY_TRADING_V2_ABI, AUSD_ABI } from "../../../lib/contracts";

const robinhoodChain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
});

const wallets = [
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
  createWallet("me.rainbow"),
];

const publicClient = createPublicClient({
  transport: http("https://rpc.testnet.chain.robinhood.com"),
});

type FollowerAllocation = {
  leader: string;
  isActive: boolean;
  capitalDeposited: number;
  capitalInPositions: number;
  highWaterMark: number;
  scaleFactor: number;
  maxSlippageBps: number;
  joinedAt: number;
};

export default function SocialDashboardPage() {
  const account = useActiveAccount();
  const [allocations, setAllocations] = useState<FollowerAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modals state
  const [selectedLeader, setSelectedLeader] = useState<string | null>(null);
  const [modalType, setModalType] = useState<"add" | "settings" | "unfollow" | null>(null);
  
  // Inputs
  const [amountInput, setAmountInput] = useState("");
  const [scaleFactorInput, setScaleFactorInput] = useState(25);
  const [slippageInput, setSlippageInput] = useState(50);
  
  // Tx State
  const [txStatus, setTxStatus] = useState<"idle" | "approving" | "confirming" | "done" | "error">("idle");
  const [txError, setTxError] = useState("");

  const fetchDashboard = useCallback(async () => {
    if (!account?.address) {
      setAllocations([]);
      setLoading(false);
      return;
    }
    try {
      setRefreshing(true);
      // Get all active leaders
      const result = await publicClient.readContract({
        address: CONTRACT_ADDRESSES.AURA_COPY_TRADING_V2 as `0x${string}`,
        abi: AURA_COPY_TRADING_V2_ABI as any,
        functionName: "getActiveLeaders",
        args: [0n, 100n],
      }) as [readonly `0x${string}`[], readonly any[]];

      const activeAddrs = result[0];
      
      if (activeAddrs.length === 0) {
        setAllocations([]);
        return;
      }

      // Fetch allocations for the current user for all these leaders using multicall
      const contracts = activeAddrs.map(addr => ({
        address: CONTRACT_ADDRESSES.AURA_COPY_TRADING_V2 as `0x${string}`,
        abi: AURA_COPY_TRADING_V2_ABI as any,
        functionName: "allocations",
        args: [addr, account.address],
      }));

      const allocResults = await publicClient.multicall({ contracts });
      
      const activeAllocations: FollowerAllocation[] = [];
      allocResults.forEach((res, index) => {
        if (res.status === "success" && res.result) {
          const alloc = res.result as any;
          if (alloc[0]) { // isActive
            activeAllocations.push({
              leader: activeAddrs[index],
              isActive: alloc[0],
              capitalDeposited: Number(formatEther(alloc[1])),
              capitalInPositions: Number(formatEther(alloc[2])),
              highWaterMark: Number(formatEther(alloc[3])),
              scaleFactor: Number(alloc[4]),
              maxSlippageBps: Number(alloc[5]),
              joinedAt: Number(alloc[6]),
            });
          }
        }
      });

      setAllocations(activeAllocations);
    } catch (err) {
      console.error("Failed to fetch dashboard:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account?.address]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  const openModal = (type: "add" | "settings" | "unfollow", leader: string, currentSF: number = 2500, currentSlip: number = 50) => {
    setModalType(type);
    setSelectedLeader(leader);
    setTxStatus("idle");
    setTxError("");
    setAmountInput("");
    if (type === "settings") {
      setScaleFactorInput(currentSF / 100);
      setSlippageInput(currentSlip);
    }
  };

  const closeModal = () => {
    setModalType(null);
    setSelectedLeader(null);
  };

  const executeAction = async () => {
    if (!account?.address || !selectedLeader) return;
    try {
      setTxError("");
      const contract = getContract({
        client,
        chain: robinhoodChain,
        address: CONTRACT_ADDRESSES.AURA_COPY_TRADING_V2,
        abi: AURA_COPY_TRADING_V2_ABI as any,
      });

      if (modalType === "unfollow") {
        setTxStatus("confirming");
        const tx = prepareContractCall({
          contract,
          method: "unfollowLeader",
          params: [selectedLeader],
        });
        const res = await sendTransaction({ account, transaction: tx });
        await waitForReceipt({ client, chain: robinhoodChain, transactionHash: res.transactionHash });
        
      } else if (modalType === "add") {
        if (!amountInput || isNaN(Number(amountInput))) throw new Error("Invalid amount");
        const parsedAmount = parseEther(amountInput);
        
        const ausdContract = getContract({
          client,
          chain: robinhoodChain,
          address: CONTRACT_ADDRESSES.AUSD,
          abi: AUSD_ABI as any,
        });

        setTxStatus("approving");
        const approveTx = prepareContractCall({
          contract: ausdContract,
          method: "approve",
          params: [CONTRACT_ADDRESSES.AURA_COPY_TRADING_V2, parsedAmount],
        });
        const appRes = await sendTransaction({ account, transaction: approveTx });
        await waitForReceipt({ client, chain: robinhoodChain, transactionHash: appRes.transactionHash });

        setTxStatus("confirming");
        const tx = prepareContractCall({
          contract,
          method: "addCapital",
          params: [selectedLeader, parsedAmount],
        });
        const res = await sendTransaction({ account, transaction: tx });
        await waitForReceipt({ client, chain: robinhoodChain, transactionHash: res.transactionHash });

      } else if (modalType === "settings") {
        setTxStatus("confirming");
        const sf = BigInt(Math.floor(scaleFactorInput * 100));
        const slip = BigInt(slippageInput);
        const tx = prepareContractCall({
          contract,
          method: "updateFollowerParams",
          params: [selectedLeader, sf, slip],
        });
        const res = await sendTransaction({ account, transaction: tx });
        await waitForReceipt({ client, chain: robinhoodChain, transactionHash: res.transactionHash });
      }

      setTxStatus("done");
      setTimeout(() => {
        closeModal();
        fetchDashboard();
      }, 2000);
      
    } catch (err: any) {
      console.error(err);
      setTxError(err.message || "Transaction failed");
      setTxStatus("error");
    }
  };

  return (
    <div className="min-h-screen bg-cyber-black text-white relative overflow-x-hidden font-mono">
      {/* Background */}
      <img src="/assets/fond_social.png" className="fixed inset-0 z-0 h-full w-full object-cover opacity-30 pointer-events-none" alt="" />
      <div className="cyber-grid-bg fixed inset-0 z-0" />
      <div className="scanlines fixed inset-0 z-[1]" />
      <div className="noise-overlay fixed inset-0 z-[1]" />

      {/* HEADER */}
      <header className="h-[48px] border-b border-[#00f0ff]/30 flex items-center justify-between px-4 bg-[#050505] relative z-50">
        <div className="flex items-center gap-3">
          <Link href="/social" className="text-white/40 hover:text-[#00f0ff] transition flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Back</span>
          </Link>
          <div className="border-l border-[#00f0ff]/20 pl-3 ml-1">
            <span className="text-[9px] text-[#00f0ff] font-bold uppercase tracking-widest bg-[#00f0ff]/10 border border-[#00f0ff]/30 px-2 py-0.5">My Copy Trades</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <motion.button
            onClick={fetchDashboard}
            disabled={refreshing}
            whileTap={{ scale: 0.92 }}
            className="p-1 rounded border border-white/10 hover:border-neon-cyan/30 hover:bg-neon-cyan/5 transition-all group"
          >
            <RefreshCw size={12} className={`transition-colors ${refreshing ? "animate-spin text-neon-cyan" : "text-gray-500 group-hover:text-neon-cyan"}`} />
          </motion.button>
          <ConnectButton client={client} wallets={wallets} chain={robinhoodChain} connectButton={{ label: "Connect", style: { fontSize: "10px", padding: "6px 12px", height: "28px" } }} />
        </div>
      </header>

      {/* CONTENT */}
      <main className="relative z-10 p-4 max-w-5xl mx-auto mt-6">
        <h1 className="text-2xl font-bold mb-8 text-transparent bg-clip-text bg-gradient-to-r from-neon-cyan to-blue-500">
          Dashboard: Copy Trading
        </h1>

        {!account ? (
          <div className="text-center py-20 border border-white/5 rounded-xl bg-black/40 backdrop-blur-md">
            <Wallet className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400">Connect your wallet to view active copy trades.</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-6 h-6 text-neon-cyan animate-spin" />
          </div>
        ) : allocations.length === 0 ? (
          <div className="text-center py-20 border border-white/5 rounded-xl bg-black/40 backdrop-blur-md">
            <Activity className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400 mb-4">You are not following any leaders.</p>
            <Link href="/social" className="px-4 py-2 bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan rounded hover:bg-neon-cyan/20 transition text-sm">
              Explore Leaderboard
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AnimatePresence>
              {allocations.map((alloc) => (
                <motion.div
                  key={alloc.leader}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-black/40 border border-white/10 rounded-xl p-5 backdrop-blur-md relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 w-32 h-32 bg-neon-cyan/5 blur-3xl" />
                  
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <div className="text-xs text-neon-cyan uppercase tracking-widest font-bold mb-1 flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-neon-cyan animate-pulse" />
                        Active Following
                      </div>
                      <Link href={`/social/trader/${alloc.leader}`} className="text-lg font-bold text-white hover:text-neon-cyan transition">
                        {shortAddr(alloc.leader)}
                      </Link>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-gray-500 uppercase tracking-widest">Deposited</div>
                      <div className="text-xl font-bold">${alloc.capitalDeposited.toFixed(2)}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-6">
                    <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                      <div className="text-[10px] text-gray-500 uppercase tracking-widest flex items-center gap-1 mb-1">
                        <TrendingUp size={10} /> Scale Factor
                      </div>
                      <div className="font-bold">{(alloc.scaleFactor / 100).toFixed(0)}%</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                      <div className="text-[10px] text-gray-500 uppercase tracking-widest flex items-center gap-1 mb-1">
                        <Shield size={10} /> Max Slippage
                      </div>
                      <div className="font-bold">{(alloc.maxSlippageBps / 100).toFixed(1)}%</div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => openModal("add", alloc.leader)}
                      className="flex-1 py-2 bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan rounded-lg text-xs font-bold hover:bg-neon-cyan/20 transition flex items-center justify-center gap-1.5"
                    >
                      <PlusSquare size={14} /> Add Capital
                    </button>
                    <button
                      onClick={() => openModal("settings", alloc.leader, alloc.scaleFactor, alloc.maxSlippageBps)}
                      className="flex-1 py-2 bg-white/5 border border-white/10 text-white rounded-lg text-xs font-bold hover:bg-white/10 transition flex items-center justify-center gap-1.5"
                    >
                      <Settings size={14} /> Settings
                    </button>
                    <button
                      onClick={() => openModal("unfollow", alloc.leader)}
                      className="w-10 flex items-center justify-center bg-red-500/10 border border-red-500/30 text-red-500 rounded-lg hover:bg-red-500/20 transition"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* MODAL */}
      <AnimatePresence>
        {modalType && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={closeModal}
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-md bg-[#050505] border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            >
              <div className="p-5 border-b border-white/10 flex justify-between items-center bg-white/[0.02]">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white flex items-center gap-2">
                  {modalType === "add" && <><PlusSquare size={14} className="text-neon-cyan" /> Add Capital</>}
                  {modalType === "settings" && <><Settings size={14} className="text-neon-cyan" /> Update Params</>}
                  {modalType === "unfollow" && <><X size={14} className="text-red-500" /> Stop Following</>}
                </h2>
                <button onClick={closeModal} className="text-gray-500 hover:text-white transition"><X size={16} /></button>
              </div>

              <div className="p-6">
                {modalType === "unfollow" ? (
                  <p className="text-gray-400 text-sm mb-6">
                    Are you sure you want to stop following {selectedLeader ? shortAddr(selectedLeader) : ""}? Your deposited capital and any realized profits will remain in your balance, but you will no longer copy their trades.
                  </p>
                ) : modalType === "add" ? (
                  <div className="mb-6">
                    <label className="text-xs text-gray-500 uppercase tracking-widest mb-2 block">Amount to add (aUSD)</label>
                    <input
                      type="text"
                      placeholder="0.00"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-neon-cyan/50 font-mono"
                    />
                  </div>
                ) : (
                  <div className="space-y-6 mb-6">
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-xs text-gray-500 uppercase tracking-widest block">Scale Factor</label>
                        <span className="text-neon-cyan font-bold">{scaleFactorInput}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="200"
                        value={scaleFactorInput}
                        onChange={(e) => setScaleFactorInput(Number(e.target.value))}
                        className="w-full h-1 bg-white/10 rounded-full appearance-none"
                      />
                      <p className="text-[10px] text-gray-500 mt-2">Adjust position sizes relative to the leader.</p>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-xs text-gray-500 uppercase tracking-widest block">Max Slippage (BPS)</label>
                        <span className="text-white font-bold">{slippageInput} bps</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="200"
                        value={slippageInput}
                        onChange={(e) => setSlippageInput(Number(e.target.value))}
                        className="w-full h-1 bg-white/10 rounded-full appearance-none"
                      />
                    </div>
                  </div>
                )}

                {txError && (
                  <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-500 text-xs break-words">
                    {txError}
                  </div>
                )}

                <button
                  onClick={executeAction}
                  disabled={txStatus === "approving" || txStatus === "confirming" || txStatus === "done"}
                  className={`w-full py-3.5 rounded-xl font-bold transition-all relative overflow-hidden ${
                    txStatus === "done" ? "bg-green-500 text-white" :
                    modalType === "unfollow" ? "bg-red-500 hover:bg-red-600 text-white" :
                    "bg-neon-cyan hover:bg-neon-cyan/90 text-black"
                  }`}
                >
                  {txStatus === "approving" ? "Approving aUSD..." :
                   txStatus === "confirming" ? "Confirming..." :
                   txStatus === "done" ? "Success!" :
                   modalType === "unfollow" ? "Confirm Unfollow" : "Submit"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
