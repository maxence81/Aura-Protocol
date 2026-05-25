"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, TrendingDown, X as XIcon } from "lucide-react";
import { useActiveAccount } from "thirdweb/react";
import { ConnectButton } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import { defineChain } from "thirdweb";
import { client } from "../client";
import { createPublicClient, http, formatUnits, createWalletClient, custom } from "viem";
import { CONTRACT_ADDRESSES, AURA_PERPS_ABI } from "../../lib/contracts";

const publicClient = createPublicClient({ transport: http("https://rpc.testnet.chain.robinhood.com") });

const robinhoodChain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  blockExplorers: [{ name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" }],
});

const wallets = [createWallet("io.metamask"), createWallet("com.coinbase.wallet"), createWallet("me.rainbow")];

type Position = {
  id: number;
  asset: string;
  isLong: boolean;
  collateral: number;
  leverage: number;
  size: number;
  entryPrice: number;
  isOpen: boolean;
  openedAt: string;
};

type PriceMap = Record<string, number>;

export default function PortfolioPage() {
  const account = useActiveAccount();
  const [positions, setPositions] = useState<Position[]>([]);
  const [prices, setPrices] = useState<PriceMap>({});
  const [closing, setClosing] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch positions
  const fetchPositions = useCallback(async () => {
    if (!account?.address) { setPositions([]); setLoading(false); return; }
    try {
      const nextId = await publicClient.readContract({
        address: CONTRACT_ADDRESSES.AURA_PERPS as `0x${string}`,
        abi: AURA_PERPS_ABI as any, functionName: "nextPositionId",
      }) as bigint;
      const count = Number(nextId);
      const calls = Array.from({ length: count }, (_, i) =>
        publicClient.readContract({
          address: CONTRACT_ADDRESSES.AURA_PERPS as `0x${string}`,
          abi: AURA_PERPS_ABI as any, functionName: "positions", args: [BigInt(i)],
        })
      );
      const results = await Promise.all(calls);
      const open: Position[] = [];
      for (let i = 0; i < count; i++) {
        const pos = results[i] as any;
        if (pos[0].toLowerCase() === account.address.toLowerCase() && pos[7]) {
          open.push({
            id: i, asset: pos[1], isLong: pos[2],
            collateral: Number(formatUnits(pos[3], 18)),
            leverage: Number(pos[4]),
            entryPrice: Number(formatUnits(pos[5], 18)),
            size: Number(formatUnits(pos[6], 18)),
            isOpen: true,
            openedAt: Number(pos[8]) > 0 ? new Date(Number(pos[8]) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Recently",
          });
        }
      }
      setPositions(open.reverse());
    } catch (e) { console.error("Position fetch error:", e); }
    setLoading(false);
  }, [account?.address]);

  // Fetch prices
  const fetchPrices = useCallback(async () => {
    try {
      const assets = ["BTC", "ETH", "AMZN", "TSLA", "AMD", "NFLX", "PLTR"];
      const results: PriceMap = {};
      for (const a of assets) {
        const p = await publicClient.readContract({
          address: CONTRACT_ADDRESSES.MOCK_ORACLE as `0x${string}`,
          abi: [{ type: "function", name: "getPrice", inputs: [{ name: "asset", type: "string" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
          functionName: "getPrice", args: [a],
        }) as bigint;
        results[a] = Number(formatUnits(p, 18));
      }
      setPrices(results);
    } catch (e) { console.error("Price fetch error:", e); }
  }, []);

  useEffect(() => { fetchPositions(); fetchPrices(); }, [fetchPositions, fetchPrices]);
  useEffect(() => { const iv = setInterval(fetchPrices, 5000); return () => clearInterval(iv); }, [fetchPrices]);

  // Close position
  const handleClose = async (positionId: number) => {
    if (!account?.address || !window.ethereum) return;
    setClosing(positionId);
    try {
      const wc = createWalletClient({
        chain: { id: 46630, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } } } as any,
        account: account.address as `0x${string}`, transport: custom(window.ethereum as any),
      });
      const tx = await wc.writeContract({
        chain: null,
        address: CONTRACT_ADDRESSES.AURA_PERPS as `0x${string}`,
        abi: AURA_PERPS_ABI as any,
        functionName: "closePosition",
        args: [BigInt(positionId)],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setPositions(prev => prev.filter(p => p.id !== positionId));
    } catch (e: any) { console.error("Close failed:", e.message); }
    setClosing(null);
  };

  // PnL calculation
  const calcPnl = (pos: Position) => {
    const assetKey = pos.asset.replace("-PERP", "");
    const currentPrice = prices[assetKey];
    if (!currentPrice || !pos.entryPrice) return { pnl: 0, pnlPct: 0 };
    const priceDelta = pos.isLong ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
    const pnl = (priceDelta / pos.entryPrice) * pos.size;
    const pnlPct = (pnl / pos.collateral) * 100;
    return { pnl, pnlPct };
  };

  // Total PnL
  const totalPnl = positions.reduce((sum, p) => sum + calcPnl(p).pnl, 0);
  const totalCollateral = positions.reduce((sum, p) => sum + p.collateral, 0);

  return (
    <div className="min-h-screen bg-[#020204] text-white font-mono relative overflow-hidden">
      <img src="/assets/fond_chat.png" className="fixed inset-0 w-full h-full object-cover opacity-40 pointer-events-none z-0" alt="" />
      <div className="cyber-grid-bg fixed inset-0 z-0" />
      <div className="scanlines fixed inset-0 z-[1]" />

      {/* Header */}
      <header className="h-[48px] border-b border-[#00f0ff]/30 flex items-center justify-between px-4 bg-[#050505] relative z-50">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-white/40 hover:text-[#00f0ff] transition flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-widest">AURA</span>
          </Link>
          <div className="border-l border-[#00f0ff]/20 pl-3 ml-1">
            <span className="text-[9px] text-[#00f0ff] font-bold uppercase tracking-widest bg-[#00f0ff]/10 border border-[#00f0ff]/30 px-2 py-0.5">Portfolio</span>
          </div>
          <Link href="/trade" className="text-[9px] text-white/30 hover:text-[#00f0ff] font-bold uppercase tracking-widest transition ml-1">Trade</Link>
          <Link href="/perp-vault" className="text-[9px] text-white/30 hover:text-[#00f0ff] font-bold uppercase tracking-widest transition ml-1">Earn Yield</Link>
        </div>
        <ConnectButton client={client} wallets={wallets} chain={robinhoodChain} connectButton={{ label: "Connect", style: { fontSize: "10px", padding: "6px 12px", height: "28px" } }} />
      </header>

      {/* Content */}
      <main className="relative z-10 max-w-5xl mx-auto px-4 py-8">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-[#0a0a0a] border border-[#00f0ff]/20 p-4">
            <p className="text-[9px] text-white/30 uppercase tracking-widest mb-1">Open Positions</p>
            <p className="text-2xl font-bold text-[#00f0ff]">{positions.length}</p>
          </div>
          <div className="bg-[#0a0a0a] border border-[#00f0ff]/20 p-4">
            <p className="text-[9px] text-white/30 uppercase tracking-widest mb-1">Total Collateral</p>
            <p className="text-2xl font-bold text-white">${totalCollateral.toFixed(2)}</p>
          </div>
          <div className="bg-[#0a0a0a] border border-[#00f0ff]/20 p-4">
            <p className="text-[9px] text-white/30 uppercase tracking-widest mb-1">Unrealized PnL</p>
            <p className={`text-2xl font-bold ${totalPnl >= 0 ? "text-[#00ff88]" : "text-[#ff2a6d]"}`}>
              {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} aUSD
            </p>
          </div>
        </div>

        {/* Positions */}
        {!account?.address ? (
          <div className="text-center py-20 text-white/30 text-sm">Connect wallet to view positions</div>
        ) : loading ? (
          <div className="text-center py-20 text-[#00f0ff]/50 text-sm animate-pulse">Loading positions...</div>
        ) : positions.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-white/30 text-sm mb-4">No open positions</p>
            <Link href="/trade" className="text-[#00f0ff] text-xs border border-[#00f0ff]/40 px-4 py-2 hover:bg-[#00f0ff]/10 transition">Open a Trade</Link>
          </div>
        ) : (
          <div className="space-y-3">
            {positions.map(pos => {
              const { pnl, pnlPct } = calcPnl(pos);
              const assetKey = pos.asset.replace("-PERP", "");
              const currentPrice = prices[assetKey] || 0;
              const isProfit = pnl >= 0;
              return (
                <div key={pos.id} className="bg-[#0a0a0a] border border-[#00f0ff]/15 p-4 flex items-center gap-4 hover:border-[#00f0ff]/40 transition">
                  {/* Direction */}
                  <div className={`w-10 h-10 flex items-center justify-center border ${pos.isLong ? "border-[#00ff88]/40 text-[#00ff88]" : "border-[#ff2a6d]/40 text-[#ff2a6d]"}`}>
                    {pos.isLong ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm">{pos.asset}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 uppercase font-bold ${pos.isLong ? "bg-[#00ff88]/10 text-[#00ff88]" : "bg-[#ff2a6d]/10 text-[#ff2a6d]"}`}>
                        {pos.isLong ? "Long" : "Short"} {pos.leverage}x
                      </span>
                    </div>
                    <div className="flex gap-4 mt-1 text-[10px] text-white/40">
                      <span>Entry: ${pos.entryPrice.toFixed(2)}</span>
                      <span>Mark: ${currentPrice.toFixed(2)}</span>
                      <span>Size: ${pos.size.toFixed(2)}</span>
                      <span>Opened: {pos.openedAt}</span>
                    </div>
                  </div>

                  {/* PnL */}
                  <div className="text-right min-w-[100px]">
                    <p className={`font-bold text-sm ${isProfit ? "text-[#00ff88]" : "text-[#ff2a6d]"}`}>
                      {isProfit ? "+" : ""}{pnl.toFixed(2)}
                    </p>
                    <p className={`text-[10px] ${isProfit ? "text-[#00ff88]/60" : "text-[#ff2a6d]/60"}`}>
                      {isProfit ? "+" : ""}{pnlPct.toFixed(2)}%
                    </p>
                  </div>

                  {/* Close button */}
                  <button
                    onClick={() => handleClose(pos.id)}
                    disabled={closing === pos.id}
                    className="px-3 py-2 border border-[#ff2a6d]/40 text-[#ff2a6d] text-[10px] font-bold uppercase tracking-widest hover:bg-[#ff2a6d]/10 transition disabled:opacity-30 flex items-center gap-1"
                  >
                    {closing === pos.id ? <span className="animate-spin w-3 h-3 border border-[#ff2a6d] border-t-transparent rounded-full" /> : <XIcon className="w-3 h-3" />}
                    Close
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
