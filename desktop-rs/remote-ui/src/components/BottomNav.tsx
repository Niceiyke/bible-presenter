import { Home, BookOpen, Music, Layers, Grid3x3, type LucideProps } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useLiveStore } from '../stores/liveStore';

export type TabId = 'live' | 'bible' | 'songs' | 'lt' | 'more';

const TABS: { id: TabId; icon: React.FC<LucideProps>; label: string }[] = [
  { id: 'live',  icon: Home,      label: 'Live'    },
  { id: 'bible', icon: BookOpen,  label: 'Bible'   },
  { id: 'songs', icon: Music,     label: 'Songs'   },
  { id: 'lt',    icon: Layers,    label: 'L.Third' },
  { id: 'more',  icon: Grid3x3,   label: 'More'    },
];

interface Props {
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
}

export function BottomNav({ activeTab, onTabChange }: Props) {
  const { connStatus } = useAuthStore();
  const liveItem = useLiveStore(s => s.liveItem);

  const connColor =
    connStatus === 'connected' ? 'var(--green)' :
    connStatus === 'connecting' ? 'var(--amber)' : 'var(--red)';

  return (
    <div
      className="fixed bottom-0 left-0 right-0 flex items-end z-50 nav-h"
      style={{
        background: 'rgba(7,9,15,0.96)',
        backdropFilter: 'blur(24px)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex w-full pb-safe" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {TABS.map(tab => {
          const active = activeTab === tab.id;
          const showLiveDot = tab.id === 'live' && !!liveItem && !active;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className="flex-1 flex flex-col items-center justify-center gap-1 py-3 cursor-pointer transition-all active:scale-90 select-none relative"
              style={{ background: 'transparent', border: 'none' }}
            >
              {showLiveDot && (
                <span
                  className="absolute top-2 right-[calc(50%-14px)] w-1.5 h-1.5 rounded-full anim-pulse-dot"
                  style={{ background: 'var(--green)' }}
                />
              )}
              <tab.icon
                size={22}
                strokeWidth={active ? 2.5 : 1.8}
                color={active ? 'var(--amber)' : 'var(--muted)'}
                style={{ transition: 'color 0.15s' }}
              />
              <span
                className="text-[10px] font-bold tracking-wide"
                style={{ color: active ? 'var(--amber)' : 'var(--muted)', transition: 'color 0.15s' }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Connection dot — bottom-right corner */}
      <div
        className="absolute right-3 top-2 w-2 h-2 rounded-full transition-colors"
        style={{ background: connColor }}
        title={connStatus}
      />
    </div>
  );
}
