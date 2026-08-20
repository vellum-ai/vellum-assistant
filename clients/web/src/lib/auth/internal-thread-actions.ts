import { isVellumStaff } from "@/lib/auth/staff";
import { useAuthStore } from "@/stores/auth-store";
import type { AuthUser } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * The internal-only thread affordances — fork ('Fork from here' on a message,
 * 'Fork Conversation' in the thread menu), 'Analyze Conversation', 'Copy
 * conversation ID', and the LLM inspector surfaces behind them — all read this
 * one predicate, so widening or narrowing the audience moves them together.
 *
 * Both halves have to agree: the `internal-thread-actions` client flag is the
 * kill switch, and the staff check is what keeps the affordances off for
 * everyone else even if the flag is ever rolled out more widely than intended.
 *
 * Staff is recognized by the shared `isVellumStaff` predicate. There is no
 * flag-only escape hatch, so local-gateway sessions — which carry no email and
 * no staff bit — never qualify.
 */
export function canUseInternalThreadActions(
  user: AuthUser | null,
  internalThreadActionsEnabled: boolean,
): boolean {
  if (!internalThreadActionsEnabled) {
    return false;
  }
  return isVellumStaff(user);
}

/**
 * Store-connected variant for render bodies. The flag reads as its registry
 * default (`false`) until `/feature-flags` hydrates, so these affordances
 * appear once the real value lands rather than flashing and disappearing.
 */
export function useCanUseInternalThreadActions(): boolean {
  const user = useAuthStore.use.user();
  const internalThreadActionsEnabled =
    useClientFeatureFlagStore.use.internalThreadActions();
  return canUseInternalThreadActions(
    user,
    internalThreadActionsEnabled === true,
  );
}
