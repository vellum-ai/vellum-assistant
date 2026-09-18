/**
 * Backwards-compat gate: server-side targeting of guardian-scoped
 * notifications.
 *
 * Old behavior (< MIN_VERSION): the assistant broadcasts a guardian-scoped
 * `notification_intent` (approval requests, access requests, channel
 * activation codes) to every SSE connection. The client drops any intent
 * carrying `targetGuardianPrincipalId`, because the connection may belong
 * to someone other than the guardian.
 *
 * New behavior (>= MIN_VERSION): the assistant delivers guardian-scoped
 * events only to connections authenticated as the guardian, so every intent
 * the client receives is one it may show.
 *
 * A local build (`-local.`) always takes the old path. Its version cannot
 * say whether it was built from a checkout that carries the targeting, and
 * guessing wrong would show the guardian's approval text on someone else's
 * connection.
 */
import {
  assistantScopedSupports,
  isLocalBuildVersion,
} from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const MIN_VERSION = "0.12.2-dev.202609181913.1108ac3";

/**
 * Whether the assistant that sent a notification delivers guardian-scoped
 * intents only to the guardian's own connections. `false` while that
 * assistant's version is unknown, and for a local build, so the client keeps
 * dropping them.
 */
export function supportsGuardianNotificationTargeting(
  assistantId: string | null | undefined,
): boolean {
  return (
    !isLocalBuildVersion(useAssistantIdentityStore.getState().version) &&
    assistantScopedSupports(MIN_VERSION, assistantId)
  );
}
