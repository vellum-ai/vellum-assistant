import { isVellumStaff } from "@/lib/auth/staff";
import { useAuthStore } from "@/stores/auth-store";
import type { AuthUser } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Whether the viewer may use the internal-only thread affordances: fork ('Fork
 * from here' on a message, 'Fork Conversation' in the thread menu), 'Analyze
 * Conversation', 'Copy Full Conversation', 'Copy conversation ID', 'Open in
 * New Window', 'Refresh', message bookmarks, and the LLM inspector surfaces
 * behind them. They all read this one predicate, so widening or narrowing the
 * audience moves them together.
 *
 * Both halves have to agree: the `internal-thread-actions` client flag is the
 * kill switch, and the staff check keeps the affordances off for everyone else
 * even if the flag is ever rolled out more widely than intended.
 *
 * Staff is recognized by the shared `isVellumStaff` predicate. There is no
 * flag-only escape hatch, so local-gateway sessions, which carry no email and
 * no staff bit, never qualify.
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
 *
 * The platform serves this gate under either `internal-thread-actions` or the
 * legacy `fork-from-message` key, and either one grants access. Both are
 * declared in the registry so the flag mapper keeps whichever the platform
 * sends (`use-client-feature-flag-sync.ts` drops keys the registry does not
 * declare).
 */
export function useCanUseInternalThreadActions(): boolean {
  const user = useAuthStore.use.user();
  const internalThreadActionsEnabled =
    useClientFeatureFlagStore.use.internalThreadActions();
  const legacyForkFlagEnabled =
    useClientFeatureFlagStore.use.forkFromMessage();
  return canUseInternalThreadActions(
    user,
    internalThreadActionsEnabled === true || legacyForkFlagEnabled === true,
  );
}
