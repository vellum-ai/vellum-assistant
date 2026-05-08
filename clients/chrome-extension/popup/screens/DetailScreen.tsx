import type { OperationEntry } from '../../background/event-log.js';

export interface DetailScreenProps {
  operation: OperationEntry;
  onBack: () => void;
}

export function DetailScreen({ operation, onBack }: DetailScreenProps) {
  return (
    <div>
      <p>Detail: {operation.operationName}</p>
      <button onClick={onBack}>Back</button>
    </div>
  );
}
