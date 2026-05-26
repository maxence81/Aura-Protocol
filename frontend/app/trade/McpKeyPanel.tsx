"use client";

import { useState, useEffect, useCallback } from "react";
import { Key, Copy, Trash2, Check, AlertTriangle } from "lucide-react";
import { API_URL } from "@/lib/config";

const MCP_SERVER_URL = process.env.NEXT_PUBLIC_MCP_URL || "http://localhost:3002";

interface McpKeyPanelProps {
  walletAddress?: string;
}

export default function McpKeyPanel({ walletAddress }: McpKeyPanelProps) {
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyPrefix, setApiKeyPrefix] = useState("");
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showConfirmRevoke, setShowConfirmRevoke] = useState(false);
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const res = await fetch(`${API_URL}/api/mcp-keys?wallet=${walletAddress}`);
      const data = await res.json();
      setHasKey(data.hasKey);
      setApiKeyPrefix(data.apiKeyPrefix || "");
    } catch { /* ignore */ }
  }, [walletAddress]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleCreate = async () => {
    if (!privateKeyInput.startsWith("0x") || privateKeyInput.length < 64) {
      setError("Invalid private key format");
      return;
    }
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API_URL}/api/mcp-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privateKey: privateKeyInput }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setNewApiKey(data.apiKey);
      setHasKey(true);
      setPrivateKeyInput("");
      setShowCreate(false);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleRevoke = async () => {
    setLoading(true);
    try {
      await fetch(`${API_URL}/api/mcp-keys`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: walletAddress }),
      });
      setHasKey(false); setNewApiKey(null); setApiKeyPrefix("");
      setShowConfirmRevoke(false);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const copyKey = () => {
    if (newApiKey) { navigator.clipboard.writeText(newApiKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  if (!walletAddress) return null;

  return (
    <div className="border border-[#00f0ff]/20 bg-[#050505] p-3 mt-2">
      <div className="flex items-center gap-2 mb-2">
        <Key className="w-3.5 h-3.5 text-[#00f0ff]" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#00f0ff]">MCP API Key</span>
        <span className="text-[8px] text-white/30 ml-auto">Any AI can trade for you</span>
      </div>

      {newApiKey && (
        <div className="bg-[#00f0ff]/5 border border-[#00f0ff]/30 p-2 mb-2">
          <p className="text-[8px] text-[#00f0ff] uppercase tracking-widest mb-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Save this key — shown only once
          </p>
          <div className="flex items-center gap-2 mb-2">
            <code className="text-[10px] text-white font-mono break-all flex-1">{newApiKey}</code>
            <button onClick={copyKey} className="p-1 border border-[#00f0ff]/30 hover:bg-[#00f0ff]/10 transition">
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-[#00f0ff]" />}
            </button>
          </div>
          <p className="text-[8px] text-white/40 mb-1">Add to Claude Desktop config:</p>
          <code className="text-[9px] text-white/60 font-mono block bg-black/50 p-1.5 break-all">
            {`{ "mcpServers": { "aura-perps": { "url": "${MCP_SERVER_URL}/mcp", "headers": { "Authorization": "Bearer ${newApiKey}" } } } }`}
          </code>
        </div>
      )}

      {hasKey && !newApiKey && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-white/60 font-mono">{apiKeyPrefix}</span>
          {showConfirmRevoke ? (
            <div className="flex gap-1">
              <button onClick={handleRevoke} disabled={loading} className="text-[8px] px-2 py-0.5 bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 transition uppercase tracking-widest">
                Confirm
              </button>
              <button onClick={() => setShowConfirmRevoke(false)} className="text-[8px] px-2 py-0.5 text-white/40 border border-white/10 hover:border-white/30 transition uppercase tracking-widest">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setShowConfirmRevoke(true)} className="flex items-center gap-1 text-[8px] px-2 py-0.5 text-red-400/70 border border-red-500/20 hover:border-red-500/50 hover:bg-red-500/10 transition uppercase tracking-widest">
              <Trash2 className="w-2.5 h-2.5" /> Revoke
            </button>
          )}
        </div>
      )}

      {!hasKey && !showCreate && (
        <button onClick={() => setShowCreate(true)} className="w-full text-[9px] py-2 border border-[#00f0ff]/30 text-[#00f0ff] hover:bg-[#00f0ff]/10 transition uppercase tracking-widest font-bold">
          Generate MCP Key
        </button>
      )}

      {!hasKey && showCreate && (
        <div className="space-y-2">
          <p className="text-[8px] text-white/40">Enter your private key to enable AI trading via MCP. It will be encrypted and stored server-side.</p>
          <input
            type="password"
            value={privateKeyInput}
            onChange={(e) => setPrivateKeyInput(e.target.value)}
            placeholder="0x..."
            className="w-full bg-[#0a0a0a] border border-[#00f0ff]/20 px-2 py-1.5 text-[10px] font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-[#00f0ff]"
          />
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={loading} className="flex-1 text-[9px] py-1.5 bg-[#00f0ff]/10 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff]/20 transition uppercase tracking-widest font-bold disabled:opacity-50">
              {loading ? "..." : "Encrypt & Save"}
            </button>
            <button onClick={() => { setShowCreate(false); setPrivateKeyInput(""); setError(""); }} className="text-[9px] py-1.5 px-3 border border-white/10 text-white/40 hover:border-white/30 transition uppercase tracking-widest">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[9px] text-red-400 mt-1">{error}</p>}
    </div>
  );
}
