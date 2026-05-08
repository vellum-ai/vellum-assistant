import type { CloudAssistant } from '../../background/cloud-api.js';

export interface PickerScreenProps {
  assistants: CloudAssistant[];
  email?: string;
  onSelect: (id: string, name: string) => void;
  onBack: () => void;
}

export function PickerScreen({
  assistants,
  email: _email,
  onSelect,
  onBack,
}: PickerScreenProps) {
  return (
    <div>
      <p>Picker</p>
      <button onClick={onBack}>Back</button>
      {assistants.map((a) => (
        <button key={a.id} onClick={() => onSelect(a.id, a.name)}>
          {a.name}
        </button>
      ))}
    </div>
  );
}
