import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAuthStore } from "@/stores/auth-store";
import type { AuthUser } from "@/stores/auth-store";

/**
 * The LLM inspector is a developer tool. Vellum staff and @vellum.ai
 * accounts always qualify; everyone else — including local-gateway
 * sessions, which carry no email or staff bit — qualifies by enabling
 * the `settings-developer-nav` assistant flag, the same flag the Swift
 * macOS client gates its Message Inspector on.
 */
export function canUseLlmInspector(
  user: AuthUser | null,
  developerNavEnabled: boolean,
): boolean {
  return (
    developerNavEnabled ||
    user?.isStaff === true ||
    user?.email?.toLowerCase().endsWith("@vellum.ai") === true
  );
}

/**
 * Store-connected variant for render bodies. Note the flag reads as
 * `false` until `/feature-flags` hydrates — gate UI that must not
 * flash a denial should also consult the store's `hasHydrated`.
 */
export function useCanUseLlmInspector(): boolean {
  const user = useAuthStore.use.user();
  const developerNavEnabled =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  return canUseLlmInspector(user, developerNavEnabled === true);
}
