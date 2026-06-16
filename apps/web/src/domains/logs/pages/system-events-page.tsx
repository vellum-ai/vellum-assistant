import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";
import {
    useActiveAssistantIsPlatformHosted,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

export function SystemEventsPage() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const assistantId = useActiveAssistantId();

  if (platformGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (platformGate === "disabled") {
    return (
      <PlatformLoginNotice>
        Log in to the Vellum platform to view system events.
      </PlatformLoginNotice>
    );
  }

  if (!isPlatformHosted) {
    return (
      <Notice tone="warning">
        System events aren&apos;t available for the current assistant.
      </Notice>
    );
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
