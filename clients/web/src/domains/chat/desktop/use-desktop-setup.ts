import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  desktopSetupGetOptions,
  useDesktopSetupPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { desktopSetupGet } from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { SYNC_TAGS } from "@/lib/sync/types";
import { toApiError } from "@/utils/api-errors";

export async function fetchDesktopSetup(
  assistantId: string,
  signal?: AbortSignal,
) {
  const { data, error, response } = await desktopSetupGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
    signal,
  });
  if (response?.status === 404) {
    // Assistants without setup support retain their direct streaming flow.
    return {
      state: "ready",
      automationActive: false,
      setupUnsupported: true,
    } as const;
  }
  if (!response?.ok || !data) {
    throw response ? toApiError(error, response) : error;
  }
  return data;
}

export function useDesktopSetupStatus(assistantId: string) {
  const queryClient = useQueryClient();
  const orgReady = useIsOrgReady();
  const options = desktopSetupGetOptions({
    path: { assistant_id: assistantId },
  });
  const query = useQuery({
    ...options,
    queryFn: ({ signal }) => fetchDesktopSetup(assistantId, signal),
    enabled: orgReady,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: (query) =>
      !query.state.data || !("setupUnsupported" in query.state.data),
    staleTime: 0,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: options.queryKey });
  useBusSubscription("sse.event", ({ message }) => {
    if (
      message.type === "desktop_activity_changed" ||
      (message.type === "sync_changed" &&
        message.tags.includes(SYNC_TAGS.assistantDesktop))
    ) {
      void refresh();
    }
  });
  useBusSubscription("sse.opened", () => {
    void refresh();
  });
  return { query, refresh };
}

export function useDesktopSetup(assistantId: string) {
  const orgReady = useIsOrgReady();
  const { query, refresh } = useDesktopSetupStatus(assistantId);
  const install = useDesktopSetupPostMutation({ onSettled: refresh });
  const { mutate } = install;
  const autoInstallFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      orgReady &&
      query.data?.state === "required" &&
      autoInstallFor.current !== assistantId
    ) {
      autoInstallFor.current = assistantId;
      mutate({ path: { assistant_id: assistantId } });
    }
  }, [assistantId, orgReady, query.data?.state, mutate]);
  return { query, install };
}
