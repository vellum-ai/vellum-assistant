import { Navigate } from "react-router";

import { EmailsTab } from "@/domains/logs/components/emails-tab";
import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

export function EmailsPage() {
  const platformGate = usePlatformGate();
  const { assistantId } = useCurrentPlatformAssistant();

  if (platformGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (platformGate === "disabled") {
    return (
      <Notice tone="info">
        Log in to the Vellum platform to view emails.
      </Notice>
    );
  }

  if (!assistantId) {
    return null;
  }

  return <EmailsTab assistantId={assistantId} platformGate={platformGate} />;
}
