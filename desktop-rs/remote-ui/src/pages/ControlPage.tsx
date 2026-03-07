import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Btn } from '../components/ui';

export function ControlPage() {
  const { isOutputBlanked, liveItem } = useLiveStore();

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      <Card>
        <CardLabel>Output Control</CardLabel>

        <Btn
          variant="danger"
          disabled={!liveItem}
          onClick={() => {
            if (window.confirm('Clear the live output?')) ws.send({ cmd: 'clear_live' });
          }}
        >
          Clear Live
        </Btn>

        <Btn
          variant={isOutputBlanked ? 'live' : 'default'}
          onClick={() => ws.send({ cmd: 'blank_output' })}
        >
          {isOutputBlanked ? 'Unblank Output' : 'Blank Output'}
        </Btn>
      </Card>

      <Card>
        <CardLabel>Lower Third</CardLabel>
        <Btn variant="danger" onClick={() => ws.send({ cmd: 'hide_lt' })}>
          Hide Lower Third
        </Btn>
      </Card>
    </div>
  );
}
