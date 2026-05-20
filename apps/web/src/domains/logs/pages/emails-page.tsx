import { useCurrentPlatformAssistant } from "@/domains/settings/hooks/use-current-platform-assistant.js";
import { EmailsTab } from "@/domains/logs/components/emails-tab.js";

export function EmailsPage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <EmailsTab assistantId={assistantId} />;
}
