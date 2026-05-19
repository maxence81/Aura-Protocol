import { Menu, Trash2, Plus } from 'lucide-react';

interface ChatHeaderProps {
  onMenuClick: () => void;
  onClearChat: () => void;
  onNewStrategy: () => void;
}

export default function ChatHeader({
  onMenuClick,
  onClearChat,
  onNewStrategy,
}: ChatHeaderProps) {
  return (
    <header className="fixed top-0 left-0 lg:left-[280px] right-0 h-16 z-30 flex items-center justify-between px-4 lg:px-6 bg-[#050505] border-b border-[#00f0ff]/40"
      style={{
        boxShadow: '0 4px 20px rgba(255,255,255,0.05)'
      }}
    >
      {/* Left */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 text-white/60 hover:text-white transition-colors cursor-pointer"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">&gt;_</span>
          <h1 className="font-mono font-bold text-sm text-white uppercase tracking-[0.2em]">
            Neural_Terminal
          </h1>
          <span className="font-kanji text-xs text-white/30 ml-1">チャット</span>
        </div>
      </div>

      {/* Center - Agent Status */}
      <div className="hidden sm:flex items-center gap-2 border border-[#00f0ff]/20 bg-[#00f0ff]/5 px-3 py-1.5">
        <span className="font-mono text-[10px] text-white/70 tracking-widest uppercase">Aura AI</span>
        <span
          className="w-1.5 h-1.5 rounded-none bg-[#00f0ff]"
          style={{ animation: 'pulse-dot 2s infinite', boxShadow: '0 0 8px rgba(255,255,255,0.5)' }}
        />
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        <button
          onClick={onClearChat}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-white/30 hover:text-white/70 transition-colors cursor-pointer font-mono text-[10px] uppercase tracking-widest"
        >
          <Trash2 size={12} />
          <span>Clear</span>
        </button>
        <button
          onClick={onNewStrategy}
          className="flex items-center gap-1.5 bg-[#00f0ff]/10 text-white px-3 py-1.5 rounded-none font-mono font-bold text-[10px] hover:bg-[#00f0ff]/20 border border-[#00f0ff] transition-all cursor-pointer uppercase tracking-widest hover:shadow-[0_0_15px_rgba(255,255,255,0.2)]"
        >
          <Plus size={12} />
          New Strategy
        </button>
      </div>
    </header>
  );
}
