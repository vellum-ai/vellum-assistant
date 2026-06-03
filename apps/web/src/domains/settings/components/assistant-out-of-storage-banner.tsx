import { Link } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Notice } from "@vellum/design-library/components/notice";
import { assistantsConnectionStatus } from "@/generated/api/sdk.gen";
import type { AssistantsConnectionStatusResponse } from "@/generated/api/types.gen";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { VELLUM_COMMUNITY_URL } from "@/utils/external-urls";
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
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const doctorEnabled = useClientFeatureFlagStore.use.doctor();

  const { data } = useQuery({
    queryKey: ["assistant-out-of-storage", assistantId] as const,
    enabled: Boolean(assistantId) && platformGate === "full" && isPlatformHosted,
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

  if (platformGate !== "full" || !isOutOfStorageStatus(data)) {
    return null;
  }

  return (
    <Notice
      tone="warning"
      title="Your assistant has run out of storage."
      actions={
        <div className="flex gap-2">
          {doctorEnabled && (
            <Button asChild variant="outlined" size="compact">
              <Link to={`${routes.settings.debug}?tab=doctor`}>
                Vellum Doctor
              </Link>
            </Button>
          )}
          <Button asChild variant="outlined" size="compact">
            <a
              href={VELLUM_COMMUNITY_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Community support
            </a>
          </Button>
        </div>
      }
    >
      {doctorEnabled
        ? "Free up disk space with Vellum Doctor. If the issue persists, ask the community for help."
        : "Your assistant has run out of disk space. Ask the community for help."}
    </Notice>
  );
}
