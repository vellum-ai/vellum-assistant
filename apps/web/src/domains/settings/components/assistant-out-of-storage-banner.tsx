import { Link } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import { assistantsConnectionStatus } from "@/generated/api/sdk.gen";
import type { AssistantsConnectionStatusResponse } from "@/generated/api/types.gen";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store";
import { routes } from "@/utils/routes";

const REFETCH_INTERVAL_MS = 30_000;

export function isOutOfStorageStatus(
  data: AssistantsConnectionStatusResponse | null | undefined,
): boolean {
  return (
    data?.state === "crash_loop" &&
    data?.pod_error_kind === "out_of_storage"
  );
}

interface AssistantOutOfStorageBannerProps {
  assistantId: string | null;
}

export function AssistantOutOfStorageBanner({
  assistantId,
}: AssistantOutOfStorageBannerProps) {
  const doctorEnabled = useClientFeatureFlagStore.use.doctor();

  const { data } = useQuery({
    queryKey: ["assistant-out-of-storage", assistantId] as const,
    enabled: Boolean(assistantId),
    refetchInterval: REFETCH_INTERVAL_MS,
    retry: false,
    queryFn: async () => {
      if (!assistantId) return null;
      const result = await assistantsConnectionStatus({
        path: { id: assistantId },
        throwOnError: false,
      });
      return result.data ?? null;
    },
  });

  if (!isOutOfStorageStatus(data)) {
    return null;
  }

  return (
    <Notice
      tone="warning"
      title="Your assistant has run out of storage."
      actions={
        doctorEnabled ? (
          <Button asChild variant="outlined" size="compact">
            <Link to={`${routes.settings.debug}?tab=doctor`}>
              Open Doctor
            </Link>
          </Button>
        ) : undefined
      }
    >
      {doctorEnabled
        ? "Free up disk space with the Doctor, or contact support if the issue persists."
        : "Contact support to increase your storage quota."}
    </Notice>
  );
}
