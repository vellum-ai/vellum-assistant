import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { integrationsTelegramConfigPost } from "@/generated/daemon/sdk.gen";

interface UseSaveTelegramConfigOptions {
  assistantId: string;
  onSuccess?: () => void;
}

/**
 * Shared mutation for saving Telegram bot credentials.
 * Invalidates channel readiness on settle so all consumers see fresh state.
 */
export function useSaveTelegramConfig({
  assistantId,
  onSuccess,
}: UseSaveTelegramConfigOptions) {
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
      return integrationsTelegramConfigPost({
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
