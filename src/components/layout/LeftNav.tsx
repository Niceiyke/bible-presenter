import React from "react";
import {
  BookOpen, CalendarDays, ChevronDown, Image as ImageIcon, Layers, Mic,
  MonitorSmartphone, Settings, Paintbrush, PanelLeftClose, PanelLeftOpen,
  CircleDot, Radio, Gauge, LayoutGrid, SlidersHorizontal, MoreHorizontal,
} from "lucide-react";
import { useAppStore } from "../../store";
import { tabAllowed, tierCapabilities } from "../../system/tiers";

type TabId = Parameters<ReturnType<typeof useAppStore.getState>["setActiveTab"]>[0];

interface NavEntry {
  id: string;
  label: string;
  icon: React.ElementType;
  shortcut?: string;
  tab: TabId;
}

const PRIMARY: NavEntry[] = [
  { id: "bible", label: "Scripture", icon: BookOpen, tab: "bible", shortcut: "F1" },
  { id: "songs", label: "Songs", icon: Mic, tab: "songs", shortcut: "F2" },
  { id: "media", label: "Media", icon: ImageIcon, tab: "media", shortcut: "F3" },
  { id: "studio", label: "Presentations", icon: Layers, tab: "studio", shortcut: "F4" },
  { id: "schedule", label: "Service Plan", icon: CalendarDays, tab: "schedule", shortcut: "F6" },
];

const MORE: NavEntry[] = [
  { id: "lt-designer", label: "LT Designer", icon: Paintbrush, tab: "lt-designer", shortcut: "F5" },
  { id: "scene-builder", label: "Scene Builder", icon: LayoutGrid, tab: "scene-builder" },
  { id: "recordings", label: "Recordings", icon: CircleDot, tab: "recordings" },
  { id: "streaming", label: "Streaming", icon: Radio, tab: "streaming" },
  { id: "remote", label: "Remote", icon: MonitorSmartphone, tab: "remote" },
  { id: "diagnostics", label: "Diagnostics", icon: Gauge, tab: "diagnostics" },
  { id: "settings", label: "Settings", icon: Settings, tab: "settings", shortcut: "F9" },
];

export function LeftNav() {
  const {
    activeTab, setActiveTab,
    bottomDeckOpen, setBottomDeckOpen,
    license,
  } = useAppStore();
  const caps = tierCapabilities(license?.tier, license?.limits);

  const [userCollapsed, setUserCollapsed] = React.useState<boolean | null>(
    () => (localStorage.getItem("pref_navCollapsed") === "1" ? true : localStorage.getItem("pref_navCollapsed") === "0" ? false : null),
  );
  const [moreOpen, setMoreOpen] = React.useState(() => localStorage.getItem("pref_navMoreOpen") === "1");
  const [narrow, setNarrow] = React.useState(() => window.innerWidth < 1120);

  React.useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1120);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const collapsed = userCollapsed !== null ? userCollapsed : narrow;
  const allowedMore = MORE.filter((entry) => tabAllowed(entry.tab, caps));
  const moreActive = allowedMore.some((entry) => activeTab === entry.tab);

  const toggleCollapsed = () => {
    const target = !collapsed;
    setUserCollapsed(target);
    localStorage.setItem("pref_navCollapsed", target ? "1" : "0");
  };

  const selectTab = (entry: NavEntry) => {
    setActiveTab(entry.tab);
    if (entry.tab === "schedule" || entry.tab === "scene-builder") setBottomDeckOpen(false);
  };

  const navButton = (entry: NavEntry) => {
    const Icon = entry.icon;
    const active = activeTab === entry.tab;
    return (
      <button
        key={entry.id}
        onClick={() => selectTab(entry)}
        title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
        aria-label={collapsed ? entry.label : undefined}
        aria-current={active ? "page" : undefined}
        className={`group relative flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
          active
            ? "bg-action-primary/12 text-action-primary shadow-sm"
            : "text-console-text-muted hover:bg-console-surface-strong hover:text-console-text"
        } ${collapsed ? "justify-center" : ""}`}
      >
        {active && <span className="absolute -left-1 h-5 w-1 rounded-r-full bg-action-primary shadow-[0_0_10px_rgba(244,183,64,.55)]" />}
        <Icon size={16} className="shrink-0" />
        {!collapsed && <>
          <span className="min-w-0 flex-1 truncate text-left text-[11px] font-bold">{entry.label}</span>
          {entry.shortcut && <span className="text-[8px] font-bold text-console-text-subtle">{entry.shortcut}</span>}
        </>}
      </button>
    );
  };

  return (
    <nav
      className={`${collapsed ? "w-14" : "w-48"} z-20 flex shrink-0 flex-col overflow-hidden border-r border-console-border bg-console-surface px-2 py-2 transition-[width] duration-150`}
      aria-label="Workspaces"
    >
      {!collapsed && <p className="mb-1 px-2 pt-1 text-[8px] font-black uppercase tracking-[0.18em] text-console-text-subtle">Prepare</p>}
      <div className="space-y-0.5">{PRIMARY.map(navButton)}</div>

      <div className="my-2 h-px bg-console-border/80" />

      <button
        onClick={() => setBottomDeckOpen(!bottomDeckOpen)}
        aria-pressed={bottomDeckOpen}
        title="Live Tools"
        className={`relative flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
          bottomDeckOpen
            ? "bg-tool-design/15 text-tool-design ring-1 ring-tool-design/25"
            : "bg-console-canvas/50 text-console-text-muted hover:bg-console-surface-strong hover:text-console-text"
        } ${collapsed ? "justify-center" : ""}`}
      >
        {bottomDeckOpen && <span className="absolute -left-1 h-5 w-1 rounded-r-full bg-tool-design" />}
        <SlidersHorizontal size={17} className="shrink-0" />
        {!collapsed && <span className="flex-1 text-left text-[11px] font-black">Live Tools</span>}
        {!collapsed && bottomDeckOpen && <span className="h-1.5 w-1.5 rounded-full bg-state-live animate-pulse" />}
      </button>

      <div className="mt-2">
        <button
          onClick={() => {
            const next = !moreOpen;
            setMoreOpen(next);
            localStorage.setItem("pref_navMoreOpen", next ? "1" : "0");
          }}
          aria-expanded={moreOpen}
          title="More workspaces"
          className={`flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 transition-colors hover:bg-console-surface-strong hover:text-console-text ${moreActive ? "text-action-primary" : "text-console-text-subtle"} ${collapsed ? "justify-center" : ""}`}
        >
          <MoreHorizontal size={16} />
          {!collapsed && <><span className="flex-1 text-left text-[10px] font-black uppercase tracking-wider">More</span><ChevronDown size={12} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} /></>}
          {collapsed && moreActive && <span className="absolute ml-5 mt-5 h-1.5 w-1.5 rounded-full bg-action-primary" />}
        </button>
        {(moreOpen || moreActive) && <div className="mt-1 space-y-0.5">{allowedMore.map(navButton)}</div>}
      </div>

      <div className="flex-1" />
      <button
        onClick={toggleCollapsed}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        className={`flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-console-text-subtle transition-colors hover:bg-console-surface-strong hover:text-console-text ${collapsed ? "justify-center" : ""}`}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} /><span className="text-[10px] font-bold">Collapse</span></>}
      </button>
    </nav>
  );
}
