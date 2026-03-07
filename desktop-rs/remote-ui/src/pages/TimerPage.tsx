import { useEffect, useRef, useState } from 'react';
import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Btn, Row } from '../components/ui';

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function TimerPage() {
  const liveItem = useLiveStore(s => s.liveItem);
  const [display, setDisplay] = useState('--:--');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const timer = liveItem?.type === 'Timer' ? liveItem.data : null;

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (!timer) {
      setDisplay('--:--');
      return;
    }

    function tick() {
      if (!timer) return;
      if (timer.started_at != null) {
        const elapsed = Math.floor((Date.now() - timer.started_at) / 1000);
        const remaining = Math.max(0, (timer.duration_secs ?? 0) - elapsed);
        setDisplay(formatTime(remaining));
      } else {
        setDisplay(formatTime(timer.duration_secs ?? 0));
      }
    }

    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [timer]);

  const running = timer?.started_at != null;

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      <Card>
        <CardLabel>Live Timer</CardLabel>

        <div className="text-center py-2" style={{ color: 'var(--muted)', fontSize: '1rem' }}>
          {timer ? (timer.label ?? timer.timer_type) : 'No timer live'}
        </div>

        <div className="text-center font-bold" style={{ fontSize: '3rem', color: 'var(--text)', letterSpacing: '0.05em' }}>
          {display}
        </div>

        <Row>
          <Btn variant="live" className="flex-1" disabled={!timer || running}
            onClick={() => ws.send({ cmd: 'start_live_timer' })}>
            Start
          </Btn>
          <Btn variant="danger" className="flex-1" disabled={!timer || !running}
            onClick={() => ws.send({ cmd: 'stop_live_timer' })}>
            Stop
          </Btn>
          <Btn className="flex-1" disabled={!timer}
            onClick={() => ws.send({ cmd: 'reset_live_timer' })}>
            Reset
          </Btn>
        </Row>
      </Card>

      {!timer && (
        <div className="text-xs text-center py-6" style={{ color: 'var(--muted)' }}>
          Stage a timer from the Schedule or Operator to control it here.
        </div>
      )}
    </div>
  );
}
