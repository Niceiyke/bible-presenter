import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ShortcutGroup = ({ title, shortcuts }: { title: string; shortcuts: { key: string; desc: string }[] }) => (
  <div className="mb-6">
    <h3 className="text-amber-500 font-bold text-xs uppercase tracking-widest mb-3 px-1">{title}</h3>
    <div className="grid grid-cols-1 gap-2">
      {shortcuts.map((s, i) => (
        <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded bg-white/[0.04] hover:bg-white/[0.08] transition-colors">
          <span className="text-slate-300 text-sm">{s.desc}</span>
          <div className="flex gap-1">
            {s.key.split(' + ').map((k, ki) => (
              <React.Fragment key={ki}>
                <kbd className="min-w-[24px] h-6 px-1.5 flex items-center justify-center bg-white/[0.12] text-slate-100 rounded text-[10px] font-bold border-b-2 border-white/20 shadow-sm">
                  {k}
                </kbd>
                {ki < s.key.split(' + ').length - 1 && <span className="text-slate-500 text-xs self-center">+</span>}
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
      title: "Schedule Navigation",
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
      title: "Tab Navigation",
      shortcuts: [
        { key: "F1", desc: "Switch to Bible Tab" },
        { key: "F2", desc: "Switch to Songs Tab" },
        { key: "F3", desc: "Switch to Media Tab" },
        { key: "F5", desc: "Toggle Design Window" },
        { key: "Ctrl + S", desc: "Open Settings Tab" },
        { key: "Ctrl + T", desc: "Toggle Bottom Deck" },
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
        { key: "Space (hold)", desc: "Push-to-talk microphone" },
      ]
    }
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className="bg-black/40 border border-white/[0.08] w-full max-w-2xl max-h-[85vh] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between bg-black/40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center text-amber-500">
              <Keyboard size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Keyboard Shortcuts</h2>
              <p className="text-xs text-slate-400">Master the Wordlyte workflow</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/[0.08] text-slate-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
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

        <footer className="px-6 py-4 border-t border-white/[0.06] bg-black/50 flex justify-between items-center">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest font-medium">Press <kbd className="bg-white/[0.05] px-1 rounded text-slate-300">ESC</kbd> to close</p>
          <button 
            onClick={onClose}
            className="px-4 py-2 bg-white/[0.05] hover:bg-white/[0.1] text-white rounded text-sm font-medium transition-colors"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
};
