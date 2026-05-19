
import { AppLink as Link } from "@/adapters/app-link.js";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import { assistantsConnectionStatus } from "@/generated/api/sdk.gen.js";
import type { AssistantsConnectionStatusResponse as ConnectionStatusResponse } from "@/generated/api/types.gen.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";
import { routes } from "@/lib/routes.js";

const REFETCH_INTERVAL_MS = 30_000;

export const POD_ERROR_KIND_OUT_OF_STORAGE = "out_of_storage" as const;

/**
 * True when the connection-status payload represents a pod stuck in a
 * crash loop classified by vembda as out-of-storage. Exported for tests
 * so we can pin the contract independently of how the banner renders.
 */
export function isOutOfStorageStatus(
  data: ConnectionStatusResponse | null | undefined,
): boolean {
  return (
    data?.state === "crash_loop" &&
    data?.pod_error_kind === POD_ERROR_KIND_OUT_OF_STORAGE
  );
}

interface AssistantOutOfStorageBannerProps {
  assistantId: string | null;
}

/**
 * Renders an inline notice when the assistant's runtime pod is in a
 * crash loop classified by vembda as out-of-storage. When the doctor
 * feature flag is enabled, the notice deep-links to the Doctor tab so
 * the user can free up disk without contacting support.
 */
export function AssistantOutOfStorageBanner({
  assistantId,
}: AssistantOutOfStorageBannerProps) {
  const { doctor: doctorEnabled } = useAppFeatureFlags();

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

  if (
    !data ||
    data.state !== "crash_loop" ||
    data.pod_error_kind !== "out_of_storage"
  ) {
    return null;
  }

  return (
    <Notice
      tone="warning"
      title="Your assistant has run out of storage."
      actions={
        doctorEnabled ? (
          <Button
            asChild
            variant="outlined"
            size="compact"
            data-testid="out-of-storage-doctor-button"
          >
            <Link href={`${routes.settings.debug}?tab=doctor`}>
              Open Doctor
            </Link>
          </Button>
        ) : undefined
      }
      data-testid="assistant-out-of-storage-banner"
    >
      {doctorEnabled
        ? "Free up disk space with the Doctor, or contact support if the issue persists."
        : "Contact support to increase your storage quota."}
    </Notice>
  );
}
