import { useAuthStore } from "@/stores/auth-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { isLocalMode } from "@/lib/local-mode";

export type PlatformGateState = "full" | "disabled" | "gated";

export function usePlatformGate(): PlatformGateState {
  const hasPlatformSession = useAuthStore.use.hasPlatformSession();
  const platformFeaturesOff = useAssistantFeatureFlagStore(
    (s) =>
      (s as Record<string, unknown>).platformFeaturesInLocalMode === false,
  );
  const hasHydrated = useAssistantFeatureFlagStore((s) => s.hasHydrated);

  if (isLocalMode() && platformFeaturesOff) return "gated";
  if (isLocalMode() && !hasHydrated) return "disabled";
  if (!hasPlatformSession) return "disabled";
  return "full";
}
