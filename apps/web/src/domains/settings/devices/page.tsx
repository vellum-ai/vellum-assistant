
import { Loader2 } from "lucide-react";

import { DeviceRow } from "@/components/app/settings/devices/device-row.js";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/generated/api/types.gen.js";
import { useQuery } from "@tanstack/react-query";

export default function DevicesSettingsPage() {
  const { data, isLoading } = useQuery(
    assistantsListOptions({ query: { hosting: "local" } }),
  );

  const devices = (data?.results ?? []) as Assistant[];

  return (
    <div className="max-w-[940px] space-y-4">
      <SettingsCard
        title="Self-Hosted Assistants"
        subtitle="Self-hosted assistants registered with your Vellum account. Registration lets these assistants use Vellum managed services — inference, web search, integrations — so that you don't have you bring your own API keys."
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
      </SettingsCard>
    </div>
  );
}
