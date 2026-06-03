import { Loader2 } from "lucide-react";
import { Navigate } from "react-router";

import { Notice } from "@vellum/design-library/components/notice";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useCurrentPlatformAssistant } from "@/hooks/use-current-platform-assistant";
import { SystemEventsTab } from "@/domains/logs/components/system-events-tab";
import { routes } from "@/utils/routes";

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
