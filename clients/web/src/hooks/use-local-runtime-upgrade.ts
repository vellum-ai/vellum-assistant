import { useMutation } from "@tanstack/react-query";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { loadLockfile } from "@/lib/local-mode";
import { upgradeLocalAssistantHost } from "@/runtime/local-mode-host";
import { useAuthStore } from "@/stores/auth-store";

interface UseLocalRuntimeUpgradeOptions {
  assistantId: string | null;
  targetVersion?: string;
}

export function useLocalRuntimeUpgrade({
  assistantId,
  targetVersion,
}: UseLocalRuntimeUpgradeOptions) {
  const mutation = useMutation({
    mutationFn: async () => {
      if (!assistantId) {
        throw new Error("No local assistant is active.");
      }
      lifecycleService.setLocalAssistantUpgradeInProgress(assistantId, true);
      try {
        const result = await upgradeLocalAssistantHost(assistantId, {
          ...(targetVersion ? { version: targetVersion } : { latest: true }),
        });
        if (!result.ok) {
          throw new Error(result.error ?? "Failed to trigger update.");
        }
        return result;
      } finally {
        lifecycleService.setLocalAssistantUpgradeInProgress(assistantId, false);
      }
    },
  });

  return {
    ...mutation,
    upgrade: async () => {
      if (!assistantId) {
        throw new Error("No local assistant is active.");
      }
      const result = await mutation.mutateAsync();
      await loadLockfile();
      clearGatewayToken();
      await useAuthStore.getState().connectLocalAssistant(assistantId);
      return result;
    },
  };
}
