import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { useAssistantWithHealthz } from "@/domains/settings/components/assistant-status-panel";
import { MemoryRetrospectiveToggle } from "@/domains/settings/components/memory-retrospective-toggle";
import { MemoryWorkerToggle } from "@/domains/settings/components/memory-worker-toggle";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function MemoryCard() {
  const { t } = useTranslation("settings");
  const { healthz } = useAssistantWithHealthz();
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const showMemoryOptOut = healthz?.capabilities?.memoryOptOut === true;

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
    enabled: showMemoryOptOut,
  });

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });
  const memoryEnabled = config?.memory?.enabled !== false;
  // The generated config type stops at `memory.retrospective` (the daemon's
  // config response schema does not enumerate the block's fields), so the read
  // is narrowed here. Absent means the schema default, which is on.
  const retrospectiveEnabled =
    (config?.memory?.retrospective as { enabled?: boolean } | undefined)
      ?.enabled !== false;

  const handleMemoryToggle = async (enabled: boolean) => {
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { memory: { enabled } },
      });
      toast.success(
        enabled
          ? t("memoryCard.enabledToast")
          : t("memoryCard.disabledToast"),
      );
    } catch (error) {
      captureError(error, { context: "settings-memory-toggle" });
      toast.error(t("memoryCard.updateFailedToast"));
    }
  };

  if (!showMemoryOptOut) {
    return null;
  }

  return (
    <DetailCard
      title={t("memoryCard.title")}
      subtitle={t("memoryCard.subtitle")}
      accessory={
        <Toggle
          checked={memoryEnabled}
          onChange={(enabled) => void handleMemoryToggle(enabled)}
          aria-label={t("memoryCard.enableAriaLabel")}
          disabled={configMutation.isPending}
        />
      }
      compactAccessory
    >
      <MemoryRetrospectiveToggle
        memoryEnabled={memoryEnabled}
        retrospectiveEnabled={retrospectiveEnabled}
      />
      <MemoryWorkerToggle memoryEnabled={memoryEnabled} />
    </DetailCard>
  );
}
