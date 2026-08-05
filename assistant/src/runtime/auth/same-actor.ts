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
 * in the audit log. The user-facing wording differs by path: the proxy
 * result names the failing comparison, while the HTTP 403 stays generic
 * because it can reach a caller who does not own the target client.
 */
import type { HostProxyCapability } from "../../channels/types.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import type { AssistantEventHub } from "../assistant-event-hub.js";
import { ForbiddenError } from "../routes/errors.js";

const log = getLogger("same-actor");

/**
 * Canonical user-facing rejection message for the HTTP/IPC route path,
 * where the caller may be any principal and the reason must not describe
 * the target client's internal state.
 */
const REJECTION_MESSAGE =
  "Submitting actor does not match the target client's actor for this request. The targeted client's authenticated user must submit the result.";

/**
 * Per-reason rejection messages for the proxy path.
 *
 * The proxy's rejection is read by the agent (and, through the transcript,
 * by the user) on their own turn, so it can and should name which of the
 * three comparisons failed. Collapsing them into one sentence made a
 * single-user desktop report that "the submitting actor does not match the
 * target client's actor" in two cases where the two actors were never
 * compared at all: the turn carried no actor principal, or the target
 * client registered its SSE stream without one. Those have different fixes
 * — re-establish the caller's identity versus reconnect the client — and
 * neither is "sign in as the other user".
 *
 * The route path keeps {@link REJECTION_MESSAGE}: an HTTP 403 can reach a
 * caller who is not the owner, and `missing_target` versus `mismatch` would
 * describe a client that is not theirs.
 */
const PROXY_REJECTION_MESSAGES: Record<RejectionReason, string> = {
  missing_source:
    "This turn has no authenticated actor, so it cannot target a connected client. Host-proxy execution binds each request to the user who sent the message; retry from a signed-in client, or check that the assistant's guardian binding resolved.",
  missing_target:
    "The target client is connected but registered without an authenticated user, so it cannot be targeted. Quit and reopen the desktop app to re-register it, then retry.",
  mismatch:
    "Submitting actor does not match the target client's actor for this request. The target client is signed in as a different user — run `assistant clients list` to see which connected clients you own.",
};

/** OpenAPI 403 description for `*-result` endpoints, kept identical. */
export const SAME_ACTOR_FORBIDDEN_DESCRIPTION =
  "Submitting client does not match the targeted client, or the submitting actor's principal does not match the target client's actor.";

/** Per-capability scope for the structured warn log entry. */
export type SameActorOp =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser"
  | "host_app_control"
  | "host_transfer"
  | "host_ui_snapshot";

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
  /**
   * Fill-if-missing fallback for dev-bypass deployments: when the PERSISTED
   * target principal is absent (the request was registered before the SSE
   * self-heal filled the target client's hub record), re-read the live hub
   * record. Only consulted when `targetActorPrincipalId` is nullish AND HTTP
   * auth is disabled. A present persisted value always wins, so a
   * present-but-mismatched principal still rejects, and JWT-auth deployments
   * are unaffected. The hub value is set server-side at SSE registration (or
   * by the self-heal), never from client input.
   */
  hubForMissingTarget?: Pick<AssistantEventHub, "getActorPrincipalIdForClient">;
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
    : (args.targetActorPrincipalId ??
      (isHttpAuthDisabled()
        ? args.hubForMissingTarget?.getActorPrincipalIdForClient(
            targetClientId,
          )
        : undefined));

  let reason: RejectionReason | undefined;
  if (sourceActorPrincipalId == null) {
    reason = "missing_source";
  } else if (targetActorPrincipalId == null) {
    reason = "missing_target";
  } else if (sourceActorPrincipalId !== targetActorPrincipalId) {
    reason = "mismatch";
  }
  if (reason == null) {
    return undefined;
  }

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
 *
 * The returned message names the failing comparison — see
 * {@link PROXY_REJECTION_MESSAGES}.
 */
export function enforceSameActorOrErrorResult(
  args: SameActorLiveArgs,
): { content: string; isError: true } | null {
  const reason = detectRejection(args);
  if (reason == null) {
    return null;
  }
  return { content: PROXY_REJECTION_MESSAGES[reason], isError: true };
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
  if (sourceActorPrincipalId == null) {
    return { kind: "none" };
  }
  const sameUser = hub
    .listClientsByCapability(capability)
    .filter((c) => c.actorPrincipalId === sourceActorPrincipalId);
  if (sameUser.length === 0) {
    return { kind: "none" };
  }
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
