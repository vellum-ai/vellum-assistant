import {
  type AdmissionDenyReason,
  ADMISSION_POLICY_DEFAULT,
  enforceAdmissionPolicy,
  isAdmissionPolicyExemptChannel,
  type TrustVerdict,
} from "@vellumai/gateway-client";
import type { Logger } from "pino";
import type { ChannelId } from "./channels/types.js";
import type { GatewayConfig } from "./config.js";
import type { StringDedupCache } from "./dedup-cache.js";
import type { InboundResult } from "./handlers/handle-inbound.js";
import { resolveAdmissionPolicy } from "./risk/admission-policy-cache.js";
import { resolveTrustVerdictOrSentinel } from "./risk/trust-verdict-resolver.js";
import {
  CircuitBreakerOpenError,
  resetConversation,
} from "./runtime/client.js";
import {
  NEW_COMMAND_ERROR,
  NEW_COMMAND_SUCCESS,
  SERVICE_UNAVAILABLE_ERROR,
} from "./webhook-copy.js";

/**
 * If the error is a CircuitBreakerOpenError, logs a warning, unreserves the
 * dedup cache entry, and returns a 503 response with Retry-After header.
 * Returns null if the error is not a circuit breaker error.
 */
export function handleCircuitBreakerError(
  err: unknown,
  dedupCache: StringDedupCache,
  cacheKey: string,
  logger: Logger,
): Response | null {
  if (!(err instanceof CircuitBreakerOpenError)) return null;

  logger.warn(
    { retryAfterSecs: err.retryAfterSecs },
    "Circuit breaker open — returning 503",
  );
  dedupCache.unreserve(cacheKey);
  return Response.json(
    { error: SERVICE_UNAVAILABLE_ERROR },
    {
      status: 503,
      headers: { "Retry-After": String(err.retryAfterSecs) },
    },
  );
}

/**
 * `authorization_unavailable` is the transient bucket: the gateway could not
 * establish authorization at all (resolver threw, verdict came back
 * could-not-vouch, policy read failed). Distinct from the definitive
 * {@link AdmissionDenyReason} denials so callers can tell "try again" from
 * "you may not do this".
 */
export type ChannelCommandDenyReason =
  | AdmissionDenyReason
  | "authorization_unavailable";

export type ChannelCommandAuthorization =
  | { allowed: true }
  | { allowed: false; reason: ChannelCommandDenyReason };

/**
 * Authorization seam for gateway-terminal channel commands (`/new`; the
 * planned `/stop` / `/fork` / `/rename` family belongs here too).
 *
 * A channel command mutates channel state without ever reaching the runtime,
 * so it must clear the same admission decision a regular inbound message
 * gets — resolved through the same primitives, not a per-channel or
 * per-command re-implementation: the channel's admission-policy floor
 * (`resolveAdmissionPolicy`), the canonical trust classifier
 * (`resolveTrustVerdict`), and the shared `enforceAdmissionPolicy` the
 * runtime admission stage evaluates. Capabilities are NOT computed here —
 * that axis stays in the runtime; this seam answers admission only.
 *
 * Divergences from message ingress, both required by the command being
 * gateway-terminal:
 *
 * - `no_one` is checked before trust resolution (a killed channel denies
 *   everyone, guardian included, without depending on the resolver) —
 *   mirroring the pre-routing kill switch in `handle-inbound.ts`.
 * - Anything that prevents a decision fails CLOSED — a could-not-vouch
 *   verdict, a throwing resolver, an unreadable policy. Message ingress
 *   fails soft because the runtime is the deny decider and treats
 *   `resolutionFailed` as could-not-vouch; for a gateway-terminal command
 *   the gateway is the decider, and could-not-vouch must not mutate state.
 * - When `resolveAdmissionPolicy` returns null (channel-trust-floors flag
 *   off), the read-path safety fallback floor applies instead of skipping
 *   the check: flag-off message ingress still gets the runtime's ACL
 *   enforcement, but a command has no runtime backstop. The trust gate on
 *   commands is a security invariant, not part of the flag-gated
 *   configurable-floors feature.
 *
 * Never rejects — callers may invoke it fire-and-forget (the Slack socket
 * path does), where a rejection would surface as an unhandled rejection
 * instead of a deny.
 */
export async function authorizeChannelCommand(
  sourceChannel: ChannelId,
  actorExternalId: string | undefined,
  logger: Logger,
): Promise<ChannelCommandAuthorization> {
  // Exempt channels (platform/a2a) are outside the human-trust model — no
  // admission policy ever applies, matching handle-inbound + the runtime.
  if (isAdmissionPolicyExemptChannel(sourceChannel)) {
    return { allowed: true };
  }

  try {
    // Policy first, so a `no_one` channel denies with zero contact-table
    // lookups — the same "true kill" property the `handle-inbound.ts` kill
    // switch is documented to have.
    const policy =
      resolveAdmissionPolicy(sourceChannel) ?? ADMISSION_POLICY_DEFAULT;
    if (policy === "no_one") {
      return { allowed: false, reason: "admission_policy_no_one" };
    }

    const verdict: TrustVerdict = await resolveTrustVerdictOrSentinel({
      channelType: sourceChannel,
      actorExternalId,
    });
    if (verdict.resolutionFailed) {
      return { allowed: false, reason: "authorization_unavailable" };
    }

    const result = enforceAdmissionPolicy({
      sourceChannel,
      trustClass: verdict.trustClass,
      memberStatus: verdict.status,
      policy,
    });
    if (!result.admitted) {
      return { allowed: false, reason: result.reason };
    }
    return { allowed: true };
  } catch (err) {
    logger.warn(
      { err, sourceChannel },
      "Channel command authorization failed to resolve — denying",
    );
    return { allowed: false, reason: "authorization_unavailable" };
  }
}

/**
 * Handles the /new command flow: authorizes the actor via
 * {@link authorizeChannelCommand}, then resets the conversation and sends a
 * success or error reply via the provided callback.
 *
 * Returns `{ handled: true }` in all cases — admit, deny, and error are all
 * terminal for this message; a denied /new must not fall through to the
 * runtime as a regular message (on a killed channel even a canned reply
 * would leak that the bot is alive).
 *
 * Deny replies: policy denials (`no_one`, below-floor, blocked/revoked) are
 * silent — a channel the guardian turned off must not respond, and actors
 * below the floor shouldn't learn the command exists. An unresolvable
 * authorization is transient, so that case gets the standard error reply.
 */
export async function handleNewCommand(
  config: GatewayConfig,
  sourceChannel: ChannelId,
  conversationExternalId: string,
  actorExternalId: string | undefined,
  sendReply: (text: string) => Promise<void>,
  logger: Logger,
  sourceThreadId?: string,
): Promise<{ handled: true }> {
  const authorization = await authorizeChannelCommand(
    sourceChannel,
    actorExternalId,
    logger,
  );
  if (!authorization.allowed) {
    logger.warn(
      {
        sourceChannel,
        conversationExternalId,
        actorExternalId,
        reason: authorization.reason,
      },
      "Denied /new command",
    );
    if (authorization.reason === "authorization_unavailable") {
      sendReply(NEW_COMMAND_ERROR).catch(() => {
        // fire-and-forget
      });
    }
    return { handled: true };
  }

  try {
    await resetConversation(
      config,
      sourceChannel,
      conversationExternalId,
      sourceThreadId,
    );
    sendReply(NEW_COMMAND_SUCCESS).catch(() => {
      // fire-and-forget — callers log send failures at their own level
    });
  } catch (err) {
    logger.error(
      { err, conversationExternalId },
      "Failed to reset conversation for /new command",
    );
    sendReply(NEW_COMMAND_ERROR).catch(() => {
      // fire-and-forget
    });
  }
  return { handled: true };
}

/**
 * Processes the result of `handleInbound()`: checks for rejections
 * (rate-limited notice via sendRejection callback) and forwarding failures
 * (unreserve cache, log error).
 * Returns `{ ok: true, rejected: false }` on successful forwarding,
 * `{ ok: true, rejected: true }` when rejected (rate-limited), or
 * `{ ok: false, status: number }` on failure.
 */
export function processInboundResult(
  result: InboundResult,
  dedupCache: StringDedupCache,
  cacheKey: string,
  sendRejection: () => void,
  logger: Logger,
): { ok: true; rejected: boolean } | { ok: false; status: number } {
  if (result.rejected) {
    sendRejection();
    return { ok: true, rejected: true };
  }

  if (result.verificationIntercepted || result.inviteIntercepted) {
    return { ok: true, rejected: false };
  }

  if (!result.forwarded) {
    logger.error({ cacheKey }, "Failed to forward message to runtime");
    dedupCache.unreserve(cacheKey);
    return { ok: false, status: 500 };
  }

  return { ok: true, rejected: false };
}

/**
 * Returns true if the message text is the /new command.
 */
export function isNewCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/new";
}

/**
 * Pending reply from a gateway verification/invite intercept, for channels
 * where the gateway couldn't deliver it via a replyCallbackUrl (email). The
 * `flag` names which intercept fired, for the webhook's JSON response.
 */
export function interceptedReply(
  result: InboundResult,
):
  | { text: string; flag: "verificationIntercepted" | "inviteIntercepted" }
  | undefined {
  if (result.verificationIntercepted && result.verificationReplyText) {
    return {
      text: result.verificationReplyText,
      flag: "verificationIntercepted",
    };
  }
  if (result.inviteIntercepted && result.inviteReplyText) {
    return { text: result.inviteReplyText, flag: "inviteIntercepted" };
  }
  return undefined;
}
