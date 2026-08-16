import React from "react";
import {
  BookOpen, CalendarDays, Image as ImageIcon, Layers, Mic, Monitor,
  MonitorSmartphone, Settings, Timer, Zap, Paintbrush, PanelLeftClose, PanelLeftOpen, Video,
  CircleDot,
} from "lucide-react";
import { useAppStore } from "../../store";

type TabId = Parameters<ReturnType<typeof useAppStore.getState>["setActiveTab"]>[0];

interface NavEntry {
  id: string;
  label: string;
  icon: React.ElementType;
  shortcut?: string;
  tab?: TabId;
  openDeck?: "live-lt" | "timer" | "props" | "camera" | "scenes";
}

interface NavGroup {
  label: string;
  entries: NavEntry[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Content",
    entries: [
      { id: "bible", label: "Scripture", icon: BookOpen, tab: "bible", shortcut: "F1" },
      { id: "songs", label: "Songs", icon: Mic, tab: "songs", shortcut: "F2" },
      { id: "media", label: "Media", icon: ImageIcon, tab: "media", shortcut: "F3" },
      { id: "studio", label: "Presentations", icon: Layers, tab: "studio", shortcut: "F4" },
    ],
  },
  {
    label: "Service",
    entries: [
      { id: "schedule", label: "Service Plan", icon: CalendarDays, tab: "schedule", shortcut: "F6" },
    ],
  },
  {
    label: "Live Tools",
    entries: [
      { id: "lt", label: "Lower Third", icon: Zap, openDeck: "live-lt" },
      { id: "timers", label: "Timers", icon: Timer, openDeck: "timer" },
      { id: "props", label: "Props", icon: Monitor, openDeck: "props" },
      { id: "camera", label: "Camera", icon: Video, openDeck: "camera" },
      { id: "scenes", label: "Scenes", icon: Zap, openDeck: "scenes" },
      { id: "lt-designer", label: "LT Designer", icon: Paintbrush, tab: "lt-designer", shortcut: "F5" },
    ],
  },
  {
    label: "System",
    entries: [
      { id: "recordings", label: "Recordings", icon: CircleDot, tab: "recordings" },
      { id: "remote", label: "Remote", icon: MonitorSmartphone, tab: "remote" },
      { id: "settings", label: "Settings", icon: Settings, tab: "settings", shortcut: "F9" },
    ],
  },
];

export function LeftNav() {
  const {
    activeTab, setActiveTab,
    bottomDeckOpen, setBottomDeckOpen,
    bottomDeckMode, setBottomDeckMode,
  } = useAppStore();

  const [userCollapsed, setUserCollapsed] = React.useState<boolean | null>(
    () => (localStorage.getItem("pref_navCollapsed") === "1" ? true : localStorage.getItem("pref_navCollapsed") === "0" ? false : null)
  );
  const [narrow, setNarrow] = React.useState(() => window.innerWidth < 1280);

  React.useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleCollapsed = () => {
    const target = !collapsed;
    setUserCollapsed(target);
    localStorage.setItem("pref_navCollapsed", target ? "1" : "0");
  };

  const collapsed = userCollapsed !== null ? userCollapsed : narrow;

  const isActive = (e: NavEntry) =>
    e.tab ? activeTab === e.tab : bottomDeckOpen && bottomDeckMode === e.openDeck;

  const select = (e: NavEntry) => {
    if (e.tab) {
      setActiveTab(e.tab);
      if (e.tab === "schedule" || e.tab === "scenes") setBottomDeckOpen(false);
    } else if (e.openDeck) {
      setBottomDeckMode(e.openDeck);
      setBottomDeckOpen(true);
    }
  };

  const width = collapsed ? "w-12" : "w-44";

  return (
    <nav
      className={`${width} bg-console-surface border-r border-console-border flex flex-col py-2 gap-0.5 shrink-0 z-20 transition-[width] duration-150 overflow-hidden`}
      aria-label="Workspaces"
    >
      {GROUPS.map((group) => (
        <div key={group.label} className="px-1.5 mb-1">
          {!collapsed && (
            <p className="px-2 pt-1.5 pb-1 text-[9px] font-black uppercase tracking-widest text-console-text-subtle">
              {group.label}
            </p>
          )}
          {group.entries.map((entry) => {
            const Icon = entry.icon;
            const active = isActive(entry);
            return (
              <button
                key={entry.id}
                onClick={() => select(entry)}
                title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
                aria-label={collapsed ? entry.label : undefined}
                aria-current={active ? "page" : undefined}
                className={`w-full flex items-center gap-2 h-9 rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  active
                    ? "bg-action-primary/10 text-action-primary border-l-2 border-action-primary"
                    : "text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"
                } px-2`}
              >
                <Icon size={15} className="shrink-0" />
                {!collapsed && (
                  <>
                    <span className="text-[11px] font-bold truncate flex-1 text-left">{entry.label}</span>
                    {entry.shortcut && (
                      <span className="text-[9px] font-bold text-console-text-subtle">{entry.shortcut}</span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}

      <div className="flex-1" />

      {/* Collapse / expand toggle */}
      <div className="px-1.5">
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand navigation" : "Collapse to icons"}
          aria-label={collapsed ? "Expand navigation (icons + labels)" : "Collapse to icons only"}
          className={`w-full flex items-center gap-2 h-9 rounded-md transition-all text-console-text-subtle hover:text-console-text hover:bg-console-surface-strong px-2 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : (
            <>
              <PanelLeftClose size={15} className="shrink-0" />
              <span className="text-[11px] font-bold truncate text-left">Collapse</span>
            </>
          )}
        </button>
      </div>
    </nav>
  );
}