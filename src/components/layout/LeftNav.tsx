import React from "react";
import {
  BookOpen, CalendarDays, Camera, Image as ImageIcon,
  Layers, Mic, Monitor, Settings, Zap, Sparkles
} from "lucide-react";
import { useAppStore } from "../../store";

export function LeftNav() {
  const { activeTab, setActiveTab, bottomDeckOpen, setBottomDeckOpen } = useAppStore();

  return (
    <nav className="w-13 bg-slate-900/60 backdrop-blur-xl border-r border-white/[0.06] flex flex-col items-center py-2 gap-1 shrink-0 z-20">
      {([
        { id: "bible",         icon: BookOpen,    title: "Bible (F1)" },
        { id: "media",         icon: ImageIcon,   title: "Media (F3)" },
        { id: "songs",         icon: Mic,         title: "Songs (F2)" },
        { id: "studio",        icon: Layers,      title: "Studio (F4)" },
        { id: "lt-designer",   icon: Zap,         title: "LT Designer (F5)" },
        { id: "schedule",      icon: CalendarDays,title: "Service" },
        { id: "scenes",        icon: Sparkles,    title: "Scenes" },
        { id: "props",         icon: Monitor,     title: "Props (F5)" },
      ] as const).map(({ id, icon: Icon, title }) => (
        <button
          key={id}
          onClick={() => setActiveTab(id)}
          title={title}
          aria-label={title}
          aria-current={activeTab === id ? "page" : undefined}
          className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 active:scale-90 ${
            activeTab === id
              ? "bg-gradient-to-br from-indigo-500/25 to-violet-500/10 text-indigo-300 ring-1 ring-indigo-400/40 shadow-lg shadow-indigo-500/20"
              : "text-slate-500 hover:text-slate-200 hover:bg-white/5"
          }`}
        >
          {activeTab === id && (
            <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-gradient-to-b from-indigo-400 to-cyan-400 shadow-[0_0_10px_rgba(99,102,241,0.8)]" />
          )}
          <Icon size={16} strokeWidth={activeTab === id ? 2.2 : 1.8} />
        </button>
      ))}

      <div className="flex-1" />

      {/* Tools toggle */}
      <button onClick={() => setBottomDeckOpen(!bottomDeckOpen)} title="Tools (Ctrl+T)"
        className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 active:scale-90 ${bottomDeckOpen ? "bg-gradient-to-br from-cyan-500/20 to-indigo-500/10 text-cyan-300 ring-1 ring-cyan-400/30" : "text-slate-500 hover:text-slate-200 hover:bg-white/5"}`}>
        <Zap size={16} strokeWidth={1.8} />
      </button>
      {/* Settings */}
      <button onClick={() => setActiveTab("settings")} title="Settings"
        className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 active:scale-90 ${activeTab === "settings" ? "bg-gradient-to-br from-indigo-500/25 to-violet-500/10 text-indigo-300 ring-1 ring-indigo-400/30 shadow-lg shadow-indigo-500/20" : "text-slate-500 hover:text-slate-200 hover:bg-white/5"}`}>
        <Settings size={16} strokeWidth={1.8} />
      </button>
    </nav>
  );
}
