
import { AssistantIdGate } from "@/components/app/pages/LogsAndUsage/AssistantIdGate.js";
import { LogsTab } from "@/components/app/pages/LogsAndUsage/LogsTab.js";

export default function LogsTracePage() {
  return (
    <AssistantIdGate>
      {(assistantId) => <LogsTab assistantId={assistantId} />}
    </AssistantIdGate>
  );
}
