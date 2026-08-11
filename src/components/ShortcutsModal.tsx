import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { IconButton } from './ui';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ShortcutGroup = ({ title, shortcuts }: { title: string; shortcuts: { key: string; desc: string }[] }) => (
  <div className="mb-6">
    <h3 className="text-action-primary font-bold text-xs uppercase tracking-widest mb-3 px-1">{title}</h3>
    <div className="grid grid-cols-1 gap-2">
      {shortcuts.map((s, i) => (
        <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded bg-console-surface-raised hover:bg-console-surface-strong transition-colors gap-3">
          <span className="text-console-text text-sm">{s.desc}</span>
          <div className="flex gap-1 shrink-0">
            {s.key.split(' + ').map((k, ki) => (
              <React.Fragment key={ki}>
                <kbd className="min-w-[24px] h-6 px-1.5 flex items-center justify-center bg-console-surface-strong text-console-text rounded text-[10px] font-bold border-b-2 border-console-border-strong shadow-sm">
                  {k}
                </kbd>
                {ki < s.key.split(' + ').length - 1 && <span className="text-console-text-subtle text-xs self-center">+</span>}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const groups = [
    {
      title: "Output Controls",
      shortcuts: [
        { key: "ESC", desc: "Clear Live Output" },
        { key: "Enter", desc: "Go Live with staged item" },
        { key: "Ctrl + G", desc: "Go Live with staged item" },
        { key: "Ctrl + B", desc: "Toggle Blackout (black screen)" },
        { key: "Ctrl + L", desc: "Clear live output only" },
        { key: "Ctrl + Shift + X", desc: "Clear All (live + staged + LT + props)" },
        { key: "Ctrl + O", desc: "Toggle Output Window" },
      ]
    },
    {
      title: "Live Navigation",
      shortcuts: [
        { key: "↓", desc: "Go Live with next schedule item" },
        { key: "↑", desc: "Go Live with previous schedule item" },
        { key: "→", desc: "Next slide / verse / song section" },
        { key: "←", desc: "Previous slide / song section" },
        { key: "Home", desc: "First slide of current item" },
        { key: "End", desc: "Last slide of current item" },
      ]
    },
    {
      title: "Workspace Navigation",
      shortcuts: [
        { key: "F1", desc: "Scripture (Bible)" },
        { key: "F2", desc: "Songs" },
        { key: "F3", desc: "Media" },
        { key: "F4", desc: "Presentations" },
        { key: "F5", desc: "LT Designer" },
        { key: "F6", desc: "Service Plan" },
        { key: "F7", desc: "Props" },
        { key: "F8", desc: "Media — Camera view" },
        { key: "F9", desc: "Settings" },
        { key: "Ctrl + T", desc: "Toggle Live Tools (Lower Third / Timers)" },
        { key: "Ctrl + S", desc: "Open Settings" },
      ]
    },
    {
      title: "Bible & Verse",
      shortcuts: [
        { key: "N", desc: "Stage Next Verse" },
        { key: "Ctrl + N", desc: "Go Live with Next Verse" },
      ]
    },
    {
      title: "Lower Thirds",
      shortcuts: [
        { key: "Ctrl + Space", desc: "Toggle Lower Third Visibility" },
        { key: "Page Down", desc: "Next Lyric Line" },
        { key: "Page Up", desc: "Previous Lyric Line" },
      ]
    },
    {
      title: "Media Controls",
      shortcuts: [
        { key: "K", desc: "Play / Pause video" },
        { key: "R", desc: "Restart video" },
        { key: "M", desc: "Mute / Unmute video" },
      ]
    },
    {
      title: "General",
      shortcuts: [
        { key: "?", desc: "Show this Shortcuts reference" },
      ]
    }
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div
        className="bg-console-surface border border-console-border-strong w-full max-w-2xl max-h-[85vh] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-console-border flex items-center justify-between bg-console-canvas/40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-action-primary/10 rounded-lg flex items-center justify-center text-action-primary">
              <Keyboard size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-console-text">Keyboard Shortcuts</h2>
              <p className="text-xs text-console-text-muted">Master the Wordlyte workflow</p>
            </div>
          </div>
          <IconButton label="Close shortcuts" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div className="space-y-2">
            {groups.slice(0, 4).map((g, i) => (
              <ShortcutGroup key={i} title={g.title} shortcuts={g.shortcuts} />
            ))}
          </div>
          <div className="space-y-2">
            {groups.slice(4).map((g, i) => (
              <ShortcutGroup key={i} title={g.title} shortcuts={g.shortcuts} />
            ))}
          </div>
        </div>

        <footer className="px-6 py-4 border-t border-console-border bg-console-canvas/40 flex justify-between items-center">
          <p className="text-[10px] text-console-text-subtle uppercase tracking-widest font-medium">
            Press <kbd className="bg-console-surface-strong px-1 rounded text-console-text">ESC</kbd> to close
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-console-surface-strong hover:bg-console-surface-raised text-console-text rounded text-sm font-medium transition-colors"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
};