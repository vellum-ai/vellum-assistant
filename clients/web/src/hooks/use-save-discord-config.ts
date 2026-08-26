import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { integrationsDiscordConfigPost } from "@/generated/daemon/sdk.gen";

interface UseSaveDiscordConfigOptions {
  assistantId: string;
  onSuccess?: () => void;
}

/**
 * Save a Discord bot token.
 *
 * Storing the credential is what connects the bot: the gateway's Discord
 * client exists while the token does and starts on the watcher's next tick.
 * So readiness is invalidated on settle like the other channels, and the
 * panel's status follows from the probe rather than from this call.
 */
export function useSaveDiscordConfig({
  assistantId,
  onSuccess,
}: UseSaveDiscordConfigOptions) {
  const queryClient = useQueryClient();
  const readinessQueryKey = useMemo(
    () => channelsReadinessGetQueryKey({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  return useMutation({
    mutationFn: (botToken: string) => {
      if (!botToken.trim()) {
        throw new Error("Bot token is required.");
      }
      return integrationsDiscordConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken: botToken.trim() },
        throwOnError: true,
      });
    },
    onSuccess,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: readinessQueryKey });
    },
  });
}
