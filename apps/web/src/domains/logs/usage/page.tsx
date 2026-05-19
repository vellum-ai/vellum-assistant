
import { AssistantIdGate } from "@/components/app/pages/LogsAndUsage/AssistantIdGate.js";
import { UsageTab } from "@/components/app/pages/LogsAndUsage/usage-tab.js";

export default function LogsUsagePage() {
  return (
    <AssistantIdGate>
      {(assistantId) => <UsageTab assistantId={assistantId} />}
    </AssistantIdGate>
  );
}
