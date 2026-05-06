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
export type SameActorOp =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser"
  | "host_transfer";

/**
 * Args for the live-lookup variant: caller supplies the hub + target client
 * id, and the helper looks up the target's actor principal in real time.
 * Used at proxy request time (registration), where the SSE subscription is
 * present by definition.
 */
export interface SameActorLiveArgs {
  hub: Pick<AssistantEventHub, "getActorPrincipalIdForClient">;
  sourceActorPrincipalId: string | undefined;
  targetClientId: string;
  op: SameActorOp;
}

/**
 * Args for the persisted-value variant: caller supplies a target actor
 * principal id captured at registration time. Used at result-submission
 * time, where the SSE subscription may have briefly disconnected and the
 * live hub lookup would falsely 403 a legitimate result.
 */
export interface SameActorPersistedArgs {
  sourceActorPrincipalId: string | undefined;
  targetActorPrincipalId: string | undefined;
  targetClientId: string;
  op: SameActorOp;
}

export type SameActorArgs = SameActorLiveArgs;

type RejectionReason = "missing_source" | "missing_target" | "mismatch";

function isLive(
  args: SameActorLiveArgs | SameActorPersistedArgs,
): args is SameActorLiveArgs {
  return (args as SameActorLiveArgs).hub != null;
}

/**
 * Internal: returns the rejection reason or `undefined` when the source
 * matches the target. Always logs on rejection so all callers share the
 * same audit shape.
 */
function detectRejection(
  args: SameActorLiveArgs | SameActorPersistedArgs,
): RejectionReason | undefined {
  const { sourceActorPrincipalId, targetClientId, op } = args;
  const targetActorPrincipalId = isLive(args)
    ? args.hub.getActorPrincipalIdForClient(targetClientId)
    : args.targetActorPrincipalId;

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
 *
 * Accepts EITHER {@link SameActorLiveArgs} (live hub lookup, used at
 * proxy registration time) OR {@link SameActorPersistedArgs} (compare
 * against a value captured earlier, used at result-submission time so a
 * brief SSE reconnect doesn't 403 a legitimate result).
 */
export function enforceSameActorOrThrow(
  args: SameActorLiveArgs | SameActorPersistedArgs,
): void {
  if (detectRejection(args) != null) {
    throw new ForbiddenError(REJECTION_MESSAGE);
  }
}

/**
 * Proxy-flavored variant: returns a tool-execution-shaped error result
 * on rejection (so the proxy can pass it directly back to the agent),
 * or `null` on success. Always uses the live hub lookup — proxy
 * registration runs while the target SSE subscription is active.
 */
export function enforceSameActorOrErrorResult(
  args: SameActorLiveArgs,
): { content: string; isError: true } | null {
  if (detectRejection(args) == null) return null;
  return { content: REJECTION_MESSAGE, isError: true };
}

/**
 * Result of attempting to auto-resolve a single same-user target client.
 *
 * - `match`: exactly one same-user client supports the capability. Use the
 *   returned clientId.
 * - `none`: no same-user client supports the capability. Caller's choice
 *   how to handle (typically: fall through to no-target, which broadcasts
 *   to nobody when no clients are connected).
 * - `ambiguous`: more than one same-user client supports the capability.
 *   Caller MUST refuse to silently broadcast across them; instead surface
 *   an error asking the caller to specify `target_client_id`.
 */
export type AutoResolveResult =
  | { kind: "match"; clientId: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/**
 * Filter capable clients by `actorPrincipalId === sourcePrincipalId` and
 * report whether exactly one matched, zero matched, or more than one
 * matched.
 *
 * Used by host proxies to auto-resolve a target client when the caller
 * did not specify one. Skipping when the caller has no principal keeps
 * the same-user binding closed: an unauthenticated caller cannot
 * piggyback on a connected user's session.
 *
 * Why three outcomes (vs. just `string | undefined`)? Earlier revisions
 * collapsed `none` and `ambiguous` into `undefined`, which caused the
 * proxy to fall through to an untargeted broadcast — fanning a single
 * targeted-style request out across every same-user machine. Surfacing
 * `ambiguous` separately lets the proxy reject with a clear "specify
 * target_client_id" error instead.
 */
export function pickSameUserAutoResolve(args: {
  hub: Pick<AssistantEventHub, "listClientsByCapability">;
  capability: HostProxyCapability;
  sourceActorPrincipalId: string | undefined;
}): AutoResolveResult {
  const { hub, capability, sourceActorPrincipalId } = args;
  if (sourceActorPrincipalId == null) return { kind: "none" };
  const sameUser = hub
    .listClientsByCapability(capability)
    .filter((c) => c.actorPrincipalId === sourceActorPrincipalId);
  if (sameUser.length === 0) return { kind: "none" };
  if (sameUser.length === 1) {
    return { kind: "match", clientId: sameUser[0].clientId };
  }
  return { kind: "ambiguous" };
}

/**
 * Standard error result for proxies when {@link pickSameUserAutoResolve}
 * returns `ambiguous`. Asks the caller to specify `target_client_id`.
 */
export function ambiguousSameUserError(capability: HostProxyCapability): {
  content: string;
  isError: true;
} {
  return {
    content: `Multiple ${capability} clients are connected for this user. Specify target_client_id to disambiguate. Run \`assistant clients list --capability ${capability}\` to see client IDs.`,
    isError: true,
  };
}
