import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  desktopAppsGetOptions,
  useDesktopAppsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { desktopAppsGet } from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { SYNC_TAGS } from "@/lib/sync/types";
import { toApiError } from "@/utils/api-errors";

export function useDesktopApps(assistantId: string) {
  const queryClient = useQueryClient();
  const orgReady = useIsOrgReady();
  const options = desktopAppsGetOptions({
    path: { assistant_id: assistantId },
  });
  const query = useQuery({
    ...options,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await desktopAppsGet({
        path: { assistant_id: assistantId },
        signal,
        throwOnError: false,
      });
      if (response?.status === 404) {
        return { apps: [] };
      }
      if (!response?.ok || !data) {
        throw response ? toApiError(error, response) : error;
      }
      return data;
    },
    enabled: orgReady,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.apps.some((app) => app.state === "installing")
        ? 2000
        : false,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: options.queryKey });
  useBusSubscription("sse.event", ({ message }) => {
    if (
      message.type === "sync_changed" &&
      message.tags.includes(SYNC_TAGS.assistantDesktop)
    ) {
      void refresh();
    }
  });
  useBusSubscription("sse.opened", () => {
    void refresh();
  });
  const action = useDesktopAppsPostMutation({ onSettled: refresh });
  return { query, action };
}
