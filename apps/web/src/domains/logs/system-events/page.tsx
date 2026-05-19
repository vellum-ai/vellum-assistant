
import { AssistantIdGate } from "@/components/app/pages/LogsAndUsage/AssistantIdGate.js";
import { SystemEventsTab } from "@/components/app/pages/LogsAndUsage/system-events-tab.js";

export default function LogsSystemEventsPage() {
  return (
    <AssistantIdGate>
      {(assistantId) => <SystemEventsTab assistantId={assistantId} />}
    </AssistantIdGate>
  );
}
