import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
    assistantsSleepPolicyDetailReadOptions,
    assistantsSleepPolicyDetailReadQueryKey,
    useAssistantsSleepPolicyDetailPartialUpdateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

const PRESET_OPTIONS: ReadonlyArray<{
  label: string;
  seconds: number;
  devOnly?: boolean;
}> = [
  { label: "Never", seconds: 0 },
  { label: "5 min", seconds: 300, devOnly: true },
  { label: "10 min", seconds: 600, devOnly: true },
  { label: "1 hour", seconds: 3600 },
  { label: "3 hours", seconds: 10800 },
  { label: "1 day", seconds: 86400 },
  { label: "3 days", seconds: 259200 },
  { label: "7 days", seconds: 604800 },
  { label: "14 days", seconds: 1209600 },
  { label: "30 days", seconds: 2592000 },
];

function formatDuration(seconds: number): string {
  if (seconds === 0) return "Never (sleep disabled)";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days} day${days !== 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  return `${seconds}s`;
}

interface AssistantSleepPolicyProps {
  assistantId: string;
}

export function AssistantSleepPolicy({
  assistantId,
}: AssistantSleepPolicyProps) {
  const queryClient = useQueryClient();
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const visibleOptions = useMemo(
    () => PRESET_OPTIONS.filter((opt) => !opt.devOnly || isNonProduction),
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
      toast.success("Sleep policy saved.");
      setLocalTimeout(null);
      queryClient.invalidateQueries({
        queryKey: assistantsSleepPolicyDetailReadQueryKey({
          path: { id: assistantId },
        }),
      });
    },
    onError: () => {
      toast.error("Failed to save sleep policy. Please try again.");
    },
  });

  if (policyLoading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sleep settings...
      </div>
    );
  }

  if (policyError) {
    return (
      <p className="text-body-medium-lighter text-[var(--system-negative-strong)]">
        Failed to load sleep policy. Refresh the page to try again.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-body-medium-default text-[var(--content-default)]">
          Idle timeout
        </label>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          How long the assistant can be idle before it is put to sleep.
          &quot;Never&quot; disables idle sleep entirely.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {visibleOptions.map((opt) => (
            <Button
              key={opt.seconds}
              variant="outlined"
              active={idleTimeoutSeconds === opt.seconds}
              onClick={() => setLocalTimeout(opt.seconds)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
          Current: {formatDuration(idleTimeoutSeconds)}
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
            Save
          </Button>
          <Button
            variant="outlined"
            onClick={() => setLocalTimeout(null)}
            disabled={policyUpdate.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
