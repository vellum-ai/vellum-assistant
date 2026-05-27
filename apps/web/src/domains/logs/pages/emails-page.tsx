import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { EmailsTab } from "@/domains/logs/components/emails-tab";

export function EmailsPage() {
  const { assistantId } = useCurrentPlatformAssistant();

  if (!assistantId) {
    return null;
  }

  return <EmailsTab assistantId={assistantId} />;
}
