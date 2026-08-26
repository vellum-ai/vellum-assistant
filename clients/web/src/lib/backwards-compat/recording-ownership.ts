import { assistantScopedSupports } from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

export const MIN_VERSION = "0.11.6-dev.202608260143.51b53b0";

export function supportsRecordingOwnership(
  assistantId: string,
): boolean | null {
  const identity = useAssistantIdentityStore.getState();
  if (identity.assistantId !== assistantId || !identity.version) {
    return null;
  }
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
