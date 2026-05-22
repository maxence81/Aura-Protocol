import { useState } from "react";
import { Activity, X } from "lucide-react";
import type { OnChainPosition, OpenLimitOrder } from "./useTradeState";

interface PositionsPanelProps {
  activeTab: "positions" | "orders" | "history";
  setActiveTab: (t: "positions" | "orders" | "history") => void;
  activePositions: OnChainPosition[];
  historyPositions: OnChainPosition[];
  openOrders: OpenLimitOrder[];
  prices: Record<string, number>;
  tpSlConfig: Record<number, { tp: string; sl: string }>;
  setTpSlConfig: (
    fn: (prev: Record<number, { tp: string; sl: string }>) => Record<number, { tp: string; sl: string }>
  ) => void;
  handleClosePosition: (id: number) => void;
  handlePartialClose: (id: number, size: number, pct: string) => void;
  handleAddMargin: (id: number, amt: string) => void;
  handleSetTriggers: (id: number) => void;
  handleCancelLimitOrder: (id: number) => void;
  handleArmShield?: (id: number, thresholdPct: number, recommendedTopUp: string, maxTopUpPerEvent: string) => void;
  handleDisarmShield?: (id: number) => void;
}

export default function PositionsPanel({
  activeTab,
  setActiveTab,
  activePositions,
  historyPositions,
  openOrders,
  prices,
  tpSlConfig,
  setTpSlConfig,
  handleClosePosition,
  handlePartialClose,
  handleAddMargin,
  handleSetTriggers,
  handleCancelLimitOrder,
  handleArmShield,
  handleDisarmShield,
}: PositionsPanelProps) {
  const [activeAction, setActiveAction] = useState<{ id: number; type: "partial" | "margin" | "shield" } | null>(null);
  const [actionValue, setActionValue] = useState("");
  // Shield modal state: when active, holds threshold % + recommended + max
  const [shieldConfig, setShieldConfig] = useState<{ threshold: string; recommended: string; max: string }>({
    threshold: "20",
    recommended: "10",
    max: "100",
  });

  const positionsData = activeTab === "positions" ? activePositions : activeTab === "history" ? historyPositions : [];

  return (
    <div className="h-[28vh] bg-[#050505] flex flex-col">
      <div className="flex text-[10px] border-b border-[#00f0ff]/30 uppercase font-mono tracking-widest bg-[#0a0a0a]">
        <button
          onClick={() => setActiveTab("positions")}
          className={`px-4 py-2 border-b-2 transition font-mono text-[10px] font-bold uppercase tracking-widest ${activeTab === "positions" ? "border-[#00f0ff] text-[#00f0ff]" : "border-transparent text-white/30 hover:text-white/60"}`}
        >
          Positions ({activePositions.length})
        </button>
        <button
          onClick={() => setActiveTab("orders")}
          className={`px-4 py-2 border-b-2 transition font-mono text-[10px] font-bold uppercase tracking-widest ${activeTab === "orders" ? "border-[#00f0ff] text-[#00f0ff]" : "border-transparent text-white/30 hover:text-white/60"}`}
        >
          My Open Orders ({openOrders.length})
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={`px-4 py-2 border-b-2 transition font-mono text-[10px] font-bold uppercase tracking-widest ${activeTab === "history" ? "border-[#00f0ff] text-[#00f0ff]" : "border-transparent text-white/30 hover:text-white/60"}`}
        >
          History ({historyPositions.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
        {activeTab === "orders" ? (
          openOrders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-white/20 text-xs font-mono">
              <Activity className="w-4 h-4 opacity-20 mb-1.5" />
              No resting limit orders
            </div>
          ) : (
            <table className="w-full text-left text-[10px] whitespace-nowrap">
              <thead>
                <tr className="text-[9px] text-[#00f0ff]/50 border-b border-[#00f0ff]/10 uppercase tracking-widest">
                  <th className="pb-1.5 font-medium">Market</th>
                  <th className="pb-1.5 font-medium">Side</th>
                  <th className="pb-1.5 font-medium">Limit Price</th>
                  <th className="pb-1.5 font-medium">Distance</th>
                  <th className="pb-1.5 font-medium">Collateral</th>
                  <th className="pb-1.5 font-medium">Size</th>
                  <th className="pb-1.5 font-medium">Placed</th>
                  <th className="pb-1.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[10px]">
                {openOrders.map((order) => {
                  const cp = prices[order.asset] || prices[`${order.asset}-PERP`] || 0;
                  const distancePct = cp > 0 ? ((order.limitPrice - cp) / cp) * 100 : 0;
                  return (
                    <tr key={order.id} className="border-b border-white/5 hover:bg-[#00f0ff]/[0.02] transition-colors">
                      <td className="py-2 font-bold text-white/70">{order.asset}-PERP</td>
                      <td className={`py-2 font-bold ${order.isLong ? "text-[#00f0ff]" : "text-[#FF2A6D]"}`}>
                        {order.isLong ? "Long" : "Short"} <span className="opacity-40">{order.leverage}x</span>
                      </td>
                      <td className="py-2 text-white/60">${order.limitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className={`py-2 ${distancePct > 0 ? "text-white/40" : "text-white/40"}`}>
                        {cp > 0 ? (
                          <span className={Math.abs(distancePct) < 0.5 ? "text-[#00f0ff]" : "text-white/40"}>
                            {distancePct >= 0 ? "+" : ""}
                            {distancePct.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-white/30">—</span>
                        )}
                      </td>
                      <td className="py-2 text-white/60">${order.collateral.toFixed(2)}</td>
                      <td className="py-2 text-white/60">${order.size.toFixed(2)}</td>
                      <td className="py-2 text-white/40">
                        {order.timestamp > 0
                          ? new Date(order.timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                          : "—"}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => handleCancelLimitOrder(order.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-[#FF2A6D]/10 text-[#FF2A6D] border border-[#FF2A6D]/20 hover:bg-[#FF2A6D] hover:text-white text-[9px] font-bold font-mono transition"
                          title="Cancel & refund collateral"
                        >
                          <X size={10} />
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : positionsData.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-white/20 text-xs font-mono">
            <Activity className="w-4 h-4 opacity-20 mb-1.5" />
            No {activeTab === "positions" ? "open" : "historical"} positions
          </div>
        ) : (
          <table className="w-full text-left text-[10px] whitespace-nowrap">
            <thead>
              <tr className="text-[9px] text-[#00f0ff]/50 border-b border-[#00f0ff]/10 uppercase tracking-widest">
                <th className="pb-1.5 font-medium">Market</th>
                <th className="pb-1.5 font-medium">Side</th>
                <th className="pb-1.5 font-medium">Collateral</th>
                <th className="pb-1.5 font-medium">Size</th>
                <th className="pb-1.5 font-medium">Entry</th>
                {activeTab === "positions" && <th className="pb-1.5 font-medium">TP / SL</th>}
                <th className="pb-1.5 font-medium">PnL</th>
                <th className="pb-1.5 font-medium">Opened</th>
                {activeTab === "positions" && <th className="pb-1.5 font-medium text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="font-mono text-[10px]">
              {positionsData.map((pos) => {
                let isProfit = false;
                let pnl = 0;
                if (pos.isOpen) {
                  const cp = prices[pos.asset] || prices[pos.asset.split("-")[0]] || 0;
                  if (pos.isLong) {
                    isProfit = cp > pos.entryPrice;
                    pnl = isProfit ? ((cp - pos.entryPrice) / pos.entryPrice) * pos.size : ((pos.entryPrice - cp) / pos.entryPrice) * pos.size;
                  } else {
                    isProfit = cp < pos.entryPrice;
                    pnl = isProfit ? ((pos.entryPrice - cp) / pos.entryPrice) * pos.size : ((cp - pos.entryPrice) / pos.entryPrice) * pos.size;
                  }
                } else {
                  isProfit = pos.isProfitRealized || false;
                  pnl = pos.realizedPnl || 0;
                }

                return (
                  <tr key={pos.id} className="border-b border-white/5 hover:bg-[#00f0ff]/[0.02] transition-colors">
                    <td className="py-2 font-bold text-white/70">{pos.asset}</td>
                    <td className={`py-2 font-bold ${pos.isLong ? "text-[#00f0ff]" : "text-[#FF2A6D]"}`}>
                      {pos.isLong ? "Long" : "Short"} <span className="opacity-40">{pos.leverage}x</span>
                    </td>
                    <td className="py-2 text-white/60">${pos.collateral.toFixed(2)}</td>
                    <td className="py-2 text-white/60">${pos.size.toFixed(2)}</td>
                    <td className="py-2 text-white/60">${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    {activeTab === "positions" && (
                      <td className="py-2">
                        <div className="flex flex-col gap-0.5 w-16">
                          <input
                            type="text"
                            placeholder="TP"
                            className="bg-[#0a0a0a] border border-[#00f0ff]/15 px-1 py-0.5 text-[9px] text-[#00f0ff] font-mono placeholder:text-[#00f0ff]/20 focus:outline-none focus:border-[#00f0ff]/40"
                            value={tpSlConfig[pos.id]?.tp ?? pos.takeProfit ?? ""}
                            onChange={(e) =>
                              setTpSlConfig((prev) => ({ ...prev, [pos.id]: { ...prev[pos.id], tp: e.target.value } }))
                            }
                          />
                          <input
                            type="text"
                            placeholder="SL"
                            className="bg-[#0a0a0a] border border-[#FF2A6D]/15 px-1 py-0.5 text-[9px] text-[#FF2A6D] font-mono placeholder:text-[#FF2A6D]/20 focus:outline-none focus:border-[#FF2A6D]/40"
                            value={tpSlConfig[pos.id]?.sl ?? pos.stopLoss ?? ""}
                            onChange={(e) =>
                              setTpSlConfig((prev) => ({ ...prev, [pos.id]: { ...prev[pos.id], sl: e.target.value } }))
                            }
                          />
                          <button
                            onClick={() => handleSetTriggers(pos.id)}
                            className="text-[8px] bg-white/5 hover:bg-white/10 text-white/60 py-0.5 font-mono transition"
                          >
                            Save
                          </button>
                        </div>
                      </td>
                    )}
                    <td className={`py-2 font-bold ${isProfit ? "text-[#00f0ff]" : "text-[#FF2A6D]"}`}>
                      {isProfit ? "+" : "-"}${pnl.toFixed(2)}
                    </td>
                    <td className="py-2 text-white/40">{pos.openedAt}</td>
                    {activeTab === "positions" && (
                      <td className="py-2 text-right">
                        {activeAction?.id === pos.id && activeAction.type === "shield" ? (
                          // Shield mandate config: 3 inputs (threshold, recommended, max)
                          <div className="flex flex-col gap-1 items-end w-32 ml-auto">
                            <input
                              type="number"
                              placeholder="Threshold %"
                              autoFocus
                              className="w-full bg-[#0a0a0a] border border-[#FFA500]/30 px-1.5 py-0.5 text-[9px] text-[#FFA500] font-mono focus:outline-none"
                              value={shieldConfig.threshold}
                              onChange={(e) => setShieldConfig(c => ({ ...c, threshold: e.target.value }))}
                            />
                            <input
                              type="number"
                              placeholder="Recommended"
                              className="w-full bg-[#0a0a0a] border border-[#00f0ff]/30 px-1.5 py-0.5 text-[9px] text-[#00f0ff] font-mono focus:outline-none"
                              value={shieldConfig.recommended}
                              onChange={(e) => setShieldConfig(c => ({ ...c, recommended: e.target.value }))}
                            />
                            <input
                              type="number"
                              placeholder="Max per event"
                              className="w-full bg-[#0a0a0a] border border-[#00f0ff]/30 px-1.5 py-0.5 text-[9px] text-[#00f0ff] font-mono focus:outline-none"
                              value={shieldConfig.max}
                              onChange={(e) => setShieldConfig(c => ({ ...c, max: e.target.value }))}
                            />
                            <div className="flex gap-1 w-full">
                              <button
                                onClick={() => setActiveAction(null)}
                                className="flex-1 px-1 py-0.5 bg-white/5 text-white/50 text-[9px] hover:bg-white/10 transition"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => {
                                  if (handleArmShield) {
                                    handleArmShield(
                                      pos.id,
                                      Number(shieldConfig.threshold),
                                      shieldConfig.recommended,
                                      shieldConfig.max,
                                    );
                                  }
                                  setActiveAction(null);
                                }}
                                className="flex-1 px-1 py-0.5 bg-[#FFA500]/10 text-[#FFA500] text-[9px] hover:bg-[#FFA500]/20 transition"
                              >
                                Arm
                              </button>
                            </div>
                          </div>
                        ) : activeAction?.id === pos.id ? (
                          <div className="flex flex-col gap-1 items-end w-24 ml-auto">
                            <input
                              type="number"
                              autoFocus
                              placeholder={activeAction.type === "partial" ? "% to close" : "aUSD margin"}
                              className="w-full bg-[#0a0a0a] border border-[#00f0ff]/30 px-1.5 py-1 text-[10px] text-[#00f0ff] font-mono focus:outline-none"
                              value={actionValue}
                              onChange={(e) => setActionValue(e.target.value)}
                            />
                            <div className="flex gap-1 w-full">
                              <button
                                onClick={() => {
                                  setActiveAction(null);
                                  setActionValue("");
                                }}
                                className="flex-1 px-1 py-0.5 bg-white/5 text-white/50 text-[9px] hover:bg-white/10 transition"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => {
                                  if (activeAction.type === "partial") handlePartialClose(pos.id, pos.size, actionValue);
                                  else handleAddMargin(pos.id, actionValue);
                                  setActiveAction(null);
                                  setActionValue("");
                                }}
                                className="flex-1 px-1 py-0.5 bg-[#00f0ff]/10 text-[#00f0ff] text-[9px] hover:bg-[#00f0ff]/20 transition"
                              >
                                Confirm
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5 items-end">
                            <button
                              onClick={() => handleClosePosition(pos.id)}
                              className="w-20 px-1.5 py-0.5 bg-[#FF2A6D]/10 text-[#FF2A6D] border border-[#FF2A6D]/20 hover:bg-[#FF2A6D] hover:text-white text-[9px] font-bold font-mono transition"
                            >
                              Close
                            </button>
                            <button
                              onClick={() => {
                                setActiveAction({ id: pos.id, type: "partial" });
                                setActionValue("50");
                              }}
                              className="w-20 px-1.5 py-0.5 bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 text-[9px] font-bold font-mono transition"
                            >
                              Partial
                            </button>
                            <button
                              onClick={() => {
                                setActiveAction({ id: pos.id, type: "margin" });
                                setActionValue("10");
                              }}
                              className="w-20 px-1.5 py-0.5 bg-[#00f0ff]/5 text-[#00f0ff]/60 border border-[#00f0ff]/15 hover:bg-[#00f0ff]/15 text-[9px] font-bold font-mono transition"
                            >
                              +Margin
                            </button>
                            {handleArmShield && (
                              <button
                                onClick={() => {
                                  setActiveAction({ id: pos.id, type: "shield" });
                                  // Pre-fill recommended = 10% of position size
                                  const rec = Math.max(5, pos.collateral * 0.25).toFixed(2);
                                  setShieldConfig({ threshold: "20", recommended: rec, max: (pos.collateral * 2).toFixed(2) });
                                }}
                                className="w-20 px-1.5 py-0.5 bg-[#FFA500]/5 text-[#FFA500]/70 border border-[#FFA500]/15 hover:bg-[#FFA500]/15 text-[9px] font-bold font-mono transition"
                                title="Arm AI Liquidation Shield"
                              >
                                🛡️ Shield
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
