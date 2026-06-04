import { Loader2 } from "lucide-react";
import { Navigate } from "react-router";

import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";
import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

export function SystemEventsPage() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const { assistantId } = useCurrentPlatformAssistant();

  if (platformGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (platformGate === "disabled") {
    return (
      <Notice tone="info">
        Log in to the Vellum platform to view system events.
      </Notice>
    );
  }

  if (isLifecycleLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading system events…
      </div>
    );
  }

  if (!isPlatformHosted) {
    return (
      <Notice tone="warning">
        System events aren&apos;t available for the current assistant.
      </Notice>
    );
  }

  if (!assistantId) {
    return null;
  }

  return <SystemEventsTab assistantId={assistantId} />;
}
