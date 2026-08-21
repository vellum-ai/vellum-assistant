import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  assistantsSleepPolicyDetailReadOptions,
  assistantsSleepPolicyDetailReadQueryKey,
  useAssistantsSleepPolicyDetailPartialUpdateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

const PRESET_SECONDS = [
  0, 300, 600, 3600, 10800, 86400, 259200, 604800, 1209600, 2592000,
] as const;

const DEV_ONLY_SECONDS = new Set([300, 600]);

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

function formatDuration(seconds: number, t: SettingsTranslate): string {
  if (seconds === 0) {
    return t("assistantSleepPolicy.neverSleep");
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0 && hours > 0) {
    return t("assistantSleepPolicy.daysHours", { days, hours });
  }
  if (days > 0) {
    return t("assistantSleepPolicy.days", { days });
  }
  if (hours > 0) {
    return t("assistantSleepPolicy.hours", { hours });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    return t("assistantSleepPolicy.minutes", { minutes });
  }
  return t("assistantSleepPolicy.seconds", { seconds });
}

function presetLabel(seconds: number, t: SettingsTranslate): string {
  switch (seconds) {
    case 0:
      return t("assistantSleepPolicy.presetNever");
    case 300:
      return t("assistantSleepPolicy.preset5Min");
    case 600:
      return t("assistantSleepPolicy.preset10Min");
    case 3600:
      return t("assistantSleepPolicy.preset1Hour");
    case 10800:
      return t("assistantSleepPolicy.preset3Hours");
    case 86400:
      return t("assistantSleepPolicy.preset1Day");
    case 259200:
      return t("assistantSleepPolicy.preset3Days");
    case 604800:
      return t("assistantSleepPolicy.preset7Days");
    case 1209600:
      return t("assistantSleepPolicy.preset14Days");
    case 2592000:
      return t("assistantSleepPolicy.preset30Days");
    default:
      return formatDuration(seconds, t);
  }
}

interface AssistantSleepPolicyProps {
  assistantId: string;
}

export function AssistantSleepPolicy({
  assistantId,
}: AssistantSleepPolicyProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const visibleOptions = useMemo(
    () =>
      PRESET_SECONDS.filter(
        (seconds) => !DEV_ONLY_SECONDS.has(seconds) || isNonProduction,
      ),
    [isNonProduction],
  );

  const {
    data: policy,
    isLoading: policyLoading,
    isError: policyError,
  } = useQuery(
    assistantsSleepPolicyDetailReadOptions({ path: { id: assistantId } }),
  );

  const baseTimeout = useMemo(
    () => policy?.idle_timeout_seconds ?? 259200,
    [policy],
  );
  const [localTimeout, setLocalTimeout] = useState<number | null>(null);
  const idleTimeoutSeconds = localTimeout ?? baseTimeout;
  const dirty = localTimeout !== null;

  const policyUpdate = useAssistantsSleepPolicyDetailPartialUpdateMutation({
    onSuccess: () => {
      toast.success(t("assistantSleepPolicy.savedToast"));
      setLocalTimeout(null);
      queryClient.invalidateQueries({
        queryKey: assistantsSleepPolicyDetailReadQueryKey({
          path: { id: assistantId },
        }),
      });
    },
    onError: () => {
      toast.error(t("assistantSleepPolicy.saveErrorToast"));
    },
  });

  if (policyLoading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("assistantSleepPolicy.loading")}
      </div>
    );
  }

  if (policyError) {
    return (
      <p className="text-body-medium-lighter text-[var(--system-negative-strong)]">
        {t("assistantSleepPolicy.loadError")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-body-medium-default text-[var(--content-default)]">
          {t("assistantSleepPolicy.idleTimeout")}
        </label>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("assistantSleepPolicy.idleTimeoutDescription")}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {visibleOptions.map((seconds) => (
            <Button
              key={seconds}
              variant="outlined"
              active={idleTimeoutSeconds === seconds}
              onClick={() => setLocalTimeout(seconds)}
            >
              {presetLabel(seconds, t)}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
          {t("assistantSleepPolicy.current", {
            duration: formatDuration(idleTimeoutSeconds, t),
          })}
        </p>
      </div>

      {dirty && (
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            leftIcon={
              policyUpdate.isPending ? (
                <Loader2 className="animate-spin" />
              ) : undefined
            }
            onClick={() =>
              policyUpdate.mutate({
                path: { id: assistantId },
                body: { idle_timeout_seconds: idleTimeoutSeconds },
              })
            }
            disabled={policyUpdate.isPending}
          >
            {t("assistantSleepPolicy.save")}
          </Button>
          <Button
            variant="outlined"
            onClick={() => setLocalTimeout(null)}
            disabled={policyUpdate.isPending}
          >
            {t("assistantSleepPolicy.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
