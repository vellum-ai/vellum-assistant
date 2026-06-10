import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { EmailsTab } from "@/domains/logs/components/emails-tab";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

export function EmailsPage() {
  const platformGate = usePlatformGate();
  const assistantId = useActiveAssistantId();

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

  return <EmailsTab assistantId={assistantId} platformGate={platformGate} />;
}
