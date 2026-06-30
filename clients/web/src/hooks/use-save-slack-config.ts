import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { integrationsSlackChannelConfigPost } from "@/generated/daemon/sdk.gen";

interface UseSaveSlackConfigOptions {
  assistantId: string;
  onSuccess?: () => void;
}

/**
 * Shared mutation for saving Slack channel credentials (bot token + app token).
 * Invalidates channel readiness on settle so all consumers see fresh state.
 */
export function useSaveSlackConfig({
  assistantId,
  onSuccess,
}: UseSaveSlackConfigOptions) {
  const queryClient = useQueryClient();
  const readinessQueryKey = useMemo(
    () => channelsReadinessGetQueryKey({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  return useMutation({
    mutationFn: ({
      botToken,
      appToken,
    }: {
      botToken: string;
      appToken: string;
    }) =>
      integrationsSlackChannelConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken, appToken },
        throwOnError: true,
      }),
    onSuccess,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: readinessQueryKey });
    },
  });
}
