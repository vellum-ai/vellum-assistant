
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { toast } from "@vellum/design-library/components/toast";
import { Button } from "@vellum/design-library/components/button";
import {
  assistantsSleepPolicyRetrieveOptions,
  assistantsSleepPolicyRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { assistantsSleepPolicyPartialUpdate } from "@/generated/api/sdk.gen.js";
import {
  assistantsSleepPolicyDetailReadOptions,
  assistantsSleepPolicyDetailReadQueryKey,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { assistantsSleepPolicyDetailPartialUpdate } from "@/generated/api/sdk.gen.js";
import type { SleepPolicy } from "@/generated/api/types.gen.js";

// Import for side effects: ensures HeyAPI client is configured.
import "@/lib/vellum-api/client.js";

const PRESET_OPTIONS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "Never", seconds: 0 },
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
  /** When true, uses admin detail endpoints that operate on a specific assistant by ID. */
  admin?: boolean;
}

export function AssistantSleepPolicy({ assistantId, admin }: AssistantSleepPolicyProps) {
  const queryClient = useQueryClient();

  const {
    data: adminPolicy,
    isLoading: adminPolicyLoading,
    isError: adminPolicyError,
  } = useQuery({
    ...assistantsSleepPolicyRetrieveOptions(),
    enabled: !!admin,
  });
  const {
    data: userPolicy,
    isLoading: userPolicyLoading,
    isError: userPolicyError,
  } = useQuery({
    ...assistantsSleepPolicyDetailReadOptions({ path: { id: assistantId } }),
    enabled: !admin,
  });

  const policy = admin ? adminPolicy : userPolicy;
  const policyLoading = admin ? adminPolicyLoading : userPolicyLoading;
  const policyError = admin ? adminPolicyError : userPolicyError;

  const baseTimeout = useMemo(
    () => (policy as SleepPolicy | undefined)?.idle_timeout_seconds ?? 259200,
    [policy],
  );
  const [localTimeout, setLocalTimeout] = useState<number | null>(null);
  const idleTimeoutSeconds = localTimeout ?? baseTimeout;
  const dirty = localTimeout !== null;

  const policyUpdate = useMutation({
    mutationFn: async (body: { idle_timeout_seconds?: number }) => {
      if (admin) {
        const { data } = await assistantsSleepPolicyPartialUpdate({
          body,
          throwOnError: true,
        });
        return data;
      }
      const { data } = await assistantsSleepPolicyDetailPartialUpdate({
        path: { id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
  });

  const handleSave = async () => {
    try {
      await policyUpdate.mutateAsync({
        idle_timeout_seconds: idleTimeoutSeconds,
      });
      toast.success("Sleep policy saved.");
      setLocalTimeout(null);
      queryClient.invalidateQueries({
        queryKey: admin
          ? assistantsSleepPolicyRetrieveQueryKey()
          : assistantsSleepPolicyDetailReadQueryKey({ path: { id: assistantId } }),
      });
    } catch {
      toast.error("Failed to save sleep policy. Please try again.");
    }
  };

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
      {/* Idle timeout selector */}
      <div>
        <label className="block text-body-medium-default text-[var(--content-default)]">
          Idle timeout
        </label>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          How long the assistant can be idle before it is put to sleep. &quot;Never&quot; disables
          idle sleep entirely.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESET_OPTIONS.map((opt) => (
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

      {/* Save button */}
      {dirty && (
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            leftIcon={policyUpdate.isPending ? <Loader2 className="animate-spin" /> : undefined}
            onClick={handleSave}
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
