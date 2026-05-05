/**
 * Same-actor (same-user) binding check used by host proxies and result
 * routes.
 *
 * Verifies that the submitting (source) actor's principal id matches the
 * actor principal id captured for the target client at SSE subscription
 * time. This is the authoritative gate that prevents cross-user
 * execution and cross-user result submission across all three host-proxy
 * capabilities (host_bash, host_file, host_cu).
 *
 * Two entry points map onto the two control-flow styles in the codebase:
 *   - {@link enforceSameActorOrErrorResult} for proxies — returns a
 *     tool-execution error result on rejection, `null` on success.
 *   - {@link enforceSameActorOrThrow} for HTTP/IPC route handlers —
 *     throws {@link ForbiddenError} on rejection so the route adapter
 *     maps it to HTTP 403.
 *
 * Both paths log a single structured warn line on rejection with the
 * shape `{ sourceActorPrincipalId, targetClientId, targetActorPrincipalId,
 * op, reason }` so that bash, file, and CU rejections render identically
 * in the audit log.
 */
import type { HostProxyCapability } from "../../channels/types.js";
import { getLogger } from "../../util/logger.js";
import type { AssistantEventHub } from "../assistant-event-hub.js";
import { ForbiddenError } from "../routes/errors.js";

const log = getLogger("same-actor");

/**
 * Canonical user-facing rejection message. Used by both the proxy and
 * route paths so operators and auditors see identical wording regardless
 * of whether the failure surfaced as a tool-execution result or an HTTP
 * 403.
 */
const REJECTION_MESSAGE =
  "Submitting actor does not match the target client's actor for this request. The targeted client's authenticated user must submit the result.";

/** OpenAPI 403 description for `*-result` endpoints, kept identical. */
export const SAME_ACTOR_FORBIDDEN_DESCRIPTION =
  "Submitting client does not match the targeted client, or the submitting actor's principal does not match the target client's actor.";

/** Per-capability scope for the structured warn log entry. */
export type SameActorOp = "host_bash" | "host_file" | "host_cu";

export interface SameActorArgs {
  hub: Pick<AssistantEventHub, "getActorPrincipalIdForClient">;
  sourceActorPrincipalId: string | undefined;
  targetClientId: string;
  op: SameActorOp;
}

type RejectionReason = "missing_source" | "missing_target" | "mismatch";

/**
 * Internal: returns the rejection reason or `undefined` when the source
 * matches the target. Always logs on rejection so all callers share the
 * same audit shape.
 */
function detectRejection(args: SameActorArgs): RejectionReason | undefined {
  const { hub, sourceActorPrincipalId, targetClientId, op } = args;
  const targetActorPrincipalId =
    hub.getActorPrincipalIdForClient(targetClientId);

  let reason: RejectionReason | undefined;
  if (sourceActorPrincipalId == null) {
    reason = "missing_source";
  } else if (targetActorPrincipalId == null) {
    reason = "missing_target";
  } else if (sourceActorPrincipalId !== targetActorPrincipalId) {
    reason = "mismatch";
  }
  if (reason == null) return undefined;

  log.warn(
    {
      sourceActorPrincipalId,
      targetClientId,
      targetActorPrincipalId,
      op,
      reason,
    },
    "Rejecting cross-user host proxy request",
  );
  return reason;
}

/**
 * Route-flavored variant: throws {@link ForbiddenError} on rejection so
 * the existing route adapter maps it to HTTP 403. Returns void on
 * success.
 */
export function enforceSameActorOrThrow(args: SameActorArgs): void {
  if (detectRejection(args) != null) {
    throw new ForbiddenError(REJECTION_MESSAGE);
  }
}

/**
 * Proxy-flavored variant: returns a tool-execution-shaped error result
 * on rejection (so the proxy can pass it directly back to the agent),
 * or `null` on success.
 */
export function enforceSameActorOrErrorResult(
  args: SameActorArgs,
): { content: string; isError: true } | null {
  if (detectRejection(args) == null) return null;
  return { content: REJECTION_MESSAGE, isError: true };
}

/**
 * Filter capable clients by `actorPrincipalId === sourcePrincipalId` and
 * return the single match's clientId, or `undefined` when zero or more
 * than one same-user client supports the capability.
 *
 * Used by host proxies to auto-resolve a target client when the caller
 * did not specify one. Skipping when the caller has no principal keeps
 * the same-user binding closed: an unauthenticated caller cannot piggyback
 * on a connected user's session.
 */
export function pickSameUserAutoResolve(args: {
  hub: Pick<AssistantEventHub, "listClientsByCapability">;
  capability: HostProxyCapability;
  sourceActorPrincipalId: string | undefined;
}): string | undefined {
  const { hub, capability, sourceActorPrincipalId } = args;
  if (sourceActorPrincipalId == null) return undefined;
  const sameUser = hub
    .listClientsByCapability(capability)
    .filter((c) => c.actorPrincipalId === sourceActorPrincipalId);
  return sameUser.length === 1 ? sameUser[0].clientId : undefined;
}
