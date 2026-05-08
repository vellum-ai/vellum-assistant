import type { OperationEntry } from '../../background/event-log.js';

export interface ActivityScreenProps {
  onBack: () => void;
  onSelectOperation: (op: OperationEntry) => void;
}

export function ActivityScreen({
  onBack,
  onSelectOperation: _onSelectOperation,
}: ActivityScreenProps) {
  return (
    <div>
      <p>Activity</p>
      <button onClick={onBack}>Back</button>
    </div>
  );
}
