import { isVellumStaff } from "@/lib/auth/staff";
import { useAuthStore } from "@/stores/auth-store";
import type { AuthUser } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Forking a conversation is a staff-only affordance behind the
 * `fork-from-message` client flag. Both halves have to agree: the flag is the
 * kill switch, and the staff check is what keeps the feature off for everyone
 * else even if the flag is ever rolled out more widely than intended.
 *
 * Staff is recognized by the shared `isVellumStaff` predicate, the same one
 * the LLM inspector gates on. Unlike the inspector there is no flag-only
 * escape hatch, so local gateway sessions never see fork.
 */
export function canForkConversation(
  user: AuthUser | null,
  forkFromMessageEnabled: boolean,
): boolean {
  if (!forkFromMessageEnabled) {
    return false;
  }
  return isVellumStaff(user);
}

/**
 * Store-connected variant for render bodies. The flag reads as its registry
 * default (`false`) until `/feature-flags` hydrates, so fork appears once the
 * real value lands rather than flashing and disappearing.
 */
export function useCanForkConversation(): boolean {
  const user = useAuthStore.use.user();
  const forkFromMessageEnabled =
    useClientFeatureFlagStore.use.forkFromMessage();
  return canForkConversation(user, forkFromMessageEnabled === true);
}
