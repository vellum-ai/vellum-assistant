import { Loader2 } from "lucide-react";
import { Navigate } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { DetailCard } from "@/components/detail-card";
import { DeviceRow } from "@/domains/settings/components/device-row";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";

export function DevicesPage() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();

  const { data, isLoading } = useQuery({
    ...assistantsListOptions({ query: { hosting: "local" } }),
    enabled: platformGate === "full" && isPlatformHosted,
  });

  const devices = (data?.results ?? []) as Assistant[];

  if (platformGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }

  if (platformGate === "disabled") {
    return (
      <div className="space-y-4">
        <Notice tone="info">
          Log in to the Vellum platform to manage self-hosted assistants.
        </Notice>
      </div>
    );
  }

  if (isLifecycleLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading devices…
        </div>
      </div>
    );
  }

  if (!isPlatformHosted) {
    return (
      <div className="space-y-4">
        <Notice tone="warning">
          Self-hosted assistant management isn&apos;t available for the current
          assistant state.
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DetailCard
        title="Self-Hosted Assistants"
        subtitle="Self-hosted assistants registered with your Vellum account. Registration lets these assistants use Vellum managed services — inference, web search, integrations — so that you don't have to bring your own API keys."
      >
        {isLoading ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading devices...
          </div>
        ) : devices.length === 0 ? (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            No self-hosted assistants registered.
          </p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => (
              <DeviceRow key={device.id} assistant={device} />
            ))}
          </div>
        )}
      </DetailCard>
    </div>
  );
}
