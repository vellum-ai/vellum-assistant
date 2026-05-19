
import { AssistantIdGate } from "@/components/app/pages/LogsAndUsage/AssistantIdGate.js";
import { EmailsTab } from "@/components/app/pages/LogsAndUsage/emails-tab.js";

export default function LogsEmailsPage() {
  return (
    <AssistantIdGate>
      {(assistantId) => <EmailsTab assistantId={assistantId} />}
    </AssistantIdGate>
  );
}
