import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export interface MemoryRetrospectiveToggleProps {
  /**
   * Whether long-term memory is enabled. Retrospectives are a memory
   * background pass, so their toggle is disabled while memory is off (memory
   * being off already pauses them).
   */
  memoryEnabled: boolean;
  /** Current `memory.retrospective.enabled`, defaulting to on when unset. */
  retrospectiveEnabled: boolean;
}

/**
 * Sub-row of the Memory settings card controlling
 * `memory.retrospective.enabled`. Unlike the background-worker row next to it,
 * this writes a persisted config value, so the state survives restarts.
 *
 * This row is what makes the Schedules "Memory retrospective" task's paused
 * notice actionable: that notice sends the user here, and without a control on
 * this page the only way back on would be editing config.json by hand.
 */
export function MemoryRetrospectiveToggle({
  memoryEnabled,
  retrospectiveEnabled,
}: MemoryRetrospectiveToggleProps) {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });

  const handleToggle = async (enabled: boolean) => {
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { memory: { retrospective: { enabled } } },
      });
      toast.success(
        enabled
          ? t("memoryRetrospectiveToggle.toastEnabled")
          : t("memoryRetrospectiveToggle.toastPaused"),
      );
    } catch (error) {
      captureError(error, { context: "settings-memory-retrospective-toggle" });
      toast.error(t("memoryRetrospectiveToggle.toastFailed"));
    }
  };

  return (
    <div className="flex flex-row items-start justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
          {t("memoryRetrospectiveToggle.title")}
        </h3>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {t("memoryRetrospectiveToggle.description")}
        </p>
      </div>
      <Toggle
        checked={retrospectiveEnabled}
        onChange={(enabled) => void handleToggle(enabled)}
        aria-label={t("memoryRetrospectiveToggle.ariaLabel")}
        disabled={!memoryEnabled || configMutation.isPending}
      />
    </div>
  );
}
