import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { memberSlackChannelsQueryKey } from "@/domains/contacts/slack-channels-query";
import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { integrationsSlackChannelConfigPost } from "@/generated/daemon/sdk.gen";

interface UseSaveSlackConfigOptions {
  assistantId: string;
  onSuccess?: () => void;
}

/**
 * Shared mutation for saving Slack channel credentials (bot token + app token).
 * Invalidates channel readiness on settle so all consumers see fresh state,
 * and drops the cached Slack channel list — new credentials may point at a
 * different workspace, whose channels the old cache would misreport.
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
    }) => {
      if (!appToken.trim()) {
        throw new Error("App token is required. Go back to step 2 to enter it.");
      }
      if (!botToken.trim()) {
        throw new Error("Bot token is required.");
      }
      return integrationsSlackChannelConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken: botToken.trim(), appToken: appToken.trim() },
        throwOnError: true,
      });
    },
    onSuccess,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: readinessQueryKey });
      queryClient.removeQueries({
        queryKey: memberSlackChannelsQueryKey(assistantId),
      });
    },
  });
}
