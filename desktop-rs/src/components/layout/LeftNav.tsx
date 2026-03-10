import React from "react";
import {
  BookOpen, CalendarDays, Camera, Image as ImageIcon,
  Layers, Layout, Mic, Monitor, Settings, Zap
} from "lucide-react";
import { useAppStore } from "../../store";

export function LeftNav() {
  const { activeTab, setActiveTab, bottomDeckOpen, setBottomDeckOpen } = useAppStore();

  return (
    <nav className="w-12 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-2 gap-0.5 shrink-0 z-20">
      {([
        { id: "bible",         icon: BookOpen,    title: "Bible (F1)" },
        { id: "media",         icon: ImageIcon,   title: "Media (F3)" },
        { id: "songs",         icon: Mic,         title: "Songs (F2)" },
        { id: "camera",        icon: Camera,      title: "Camera (F5)" },
        { id: "studio",        icon: Layers,      title: "Studio (F4)" },
        { id: "scenes",        icon: Layout,      title: "Scenes (F6)" },
        { id: "scene-builder", icon: Layout,      title: "Scene Builder (F7)" },
        { id: "schedule",      icon: CalendarDays,title: "Service" },
        { id: "props",         icon: Monitor,     title: "Props (F8)" },
      ] as const).map(({ id, icon: Icon, title }) => (
        <button key={id} onClick={() => setActiveTab(id)} title={title}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
            activeTab === id
              ? "bg-amber-500/10 text-amber-400 border-l-2 border-amber-400"
              : "text-slate-600 hover:text-slate-300 hover:bg-slate-800"
          }`}>
          <Icon size={16} />
        </button>
      ))}

      <div className="flex-1" />

      {/* Tools toggle */}
      <button onClick={() => setBottomDeckOpen(!bottomDeckOpen)} title="Tools (Ctrl+T)"
        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${bottomDeckOpen ? "bg-purple-500/10 text-purple-400" : "text-slate-600 hover:text-slate-300 hover:bg-slate-800"}`}>
        <Zap size={16} />
      </button>
      {/* Settings */}
      <button onClick={() => setActiveTab("settings")} title="Settings"
        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${activeTab === "settings" ? "bg-amber-500/10 text-amber-400" : "text-slate-600 hover:text-slate-300 hover:bg-slate-800"}`}>
        <Settings size={16} />
      </button>
    </nav>
  );
}
