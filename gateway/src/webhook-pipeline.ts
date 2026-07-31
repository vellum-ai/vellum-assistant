import {
  type AdmissionPolicy,
  ADMISSION_POLICY_DEFAULT,
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
 * Gateway-owned part of authorizing a gateway-terminal channel command
 * (`/new`; the planned `/stop` / `/fork` / `/rename` family belongs here too).
 *
 * The gateway owns exactly ONE half of the decision, the same half it owns for
 * a message: the `no_one` kill switch, enforced before any I/O so a channel
 * the guardian turned off denies everyone (guardian included) with zero
 * contact-table lookups. That is the "true kill" property documented for
 * `handle-inbound.ts`.
 *
 * It deliberately does NOT decide anything else. The rest (verdict usability,
 * per-channel `policy: "deny"`, the admission floor, and whether the actor's
 * trust class may drive an interactive control action at all) is resolved in
 * the RUNTIME by `handleDeleteConversation`, using the same primitives the
 * message pipeline uses. The gateway resolves the actor's verdict and the
 * channel floor and forwards them, exactly as it stamps `sourceMetadata` on an
 * inbound message; it never re-derives the decision. Capabilities stay in the
 * runtime per `gateway/CLAUDE.md`.
 */
export type ChannelCommandGate =
  | {
      killed: false;
      trustVerdict: TrustVerdict;
      admissionPolicy?: AdmissionPolicy;
    }
  | { killed: true };

export async function resolveChannelCommandGate(
  sourceChannel: ChannelId,
  actorExternalId: string | undefined,
): Promise<ChannelCommandGate> {
  // Exempt channels (platform/a2a) sit outside the human-trust model, matching
  // handle-inbound and the runtime admission stage.
  const admissionPolicy = isAdmissionPolicyExemptChannel(sourceChannel)
    ? undefined
    : (resolveAdmissionPolicy(sourceChannel) ?? ADMISSION_POLICY_DEFAULT);

  if (admissionPolicy === "no_one") {
    return { killed: true };
  }

  const trustVerdict = await resolveTrustVerdictOrSentinel({
    channelType: sourceChannel,
    actorExternalId,
  });

  return {
    killed: false,
    trustVerdict,
    ...(admissionPolicy ? { admissionPolicy } : {}),
  };
}

/**
 * Handles the /new command flow: resolves the gateway-owned gate, asks the
 * runtime to reset (which authorizes the actor), and replies.
 *
 * Returns `{ handled: true }` in all cases: admit, deny, and error are all
 * terminal for this message. A denied /new must not fall through to the
 * runtime as a regular message, and on a killed channel even a canned reply
 * would leak that the bot is alive.
 *
 * Deny replies are silent. A channel the guardian turned off must not
 * respond, and an actor below the bar should not learn the command exists.
 * Only a transient failure (the reset could not be attempted or the runtime
 * errored) sends text, and it goes through the throttled `sendNotice` so a
 * repeated `/new` cannot amplify into one outbound send per inbound message.
 *
 * Routing is deliberately not consulted: the reset does not use an
 * `assistantId`, and `resolveAssistant` rejects only an event carrying no
 * routable identity at all, which has no sender to reply to.
 */
export interface NewCommandRequest {
  config: GatewayConfig;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorExternalId: string | undefined;
  /** Reply to an authorized actor. Not throttled. */
  sendReply: (text: string) => Promise<void>;
  /** Throttled notice, used only for transient failures. */
  sendNotice: (text: string) => void;
  logger: Logger;
  sourceThreadId?: string;
}

export type NewCommandOutcome = "reset" | "denied" | "killed" | "unavailable";

export async function handleNewCommand(
  req: NewCommandRequest,
): Promise<{ handled: true; outcome: NewCommandOutcome }> {
  const {
    config,
    sourceChannel,
    conversationExternalId,
    actorExternalId,
    logger,
  } = req;

  let gate: ChannelCommandGate;
  try {
    gate = await resolveChannelCommandGate(sourceChannel, actorExternalId);
  } catch (err) {
    // Fail closed: an unreadable policy or a broken resolver must not reset.
    logger.warn(
      { err, sourceChannel, conversationExternalId },
      "Could not resolve the channel command gate, denying /new",
    );
    req.sendNotice(NEW_COMMAND_ERROR);
    return { handled: true, outcome: "unavailable" };
  }

  if (gate.killed) {
    logger.warn(
      { sourceChannel, conversationExternalId, actorExternalId },
      "Denied /new command: channel admission policy is no_one",
    );
    return { handled: true, outcome: "killed" };
  }

  try {
    const result = await resetConversation(config, {
      sourceChannel,
      conversationExternalId,
      sourceThreadId: req.sourceThreadId,
      trustVerdict: gate.trustVerdict,
      ...(gate.admissionPolicy
        ? { admissionPolicy: gate.admissionPolicy }
        : {}),
    });

    if (result.denied) {
      logger.warn(
        {
          sourceChannel,
          conversationExternalId,
          actorExternalId,
          trustClass: gate.trustVerdict.trustClass,
          reason: result.reason,
        },
        "Denied /new command: runtime refused the reset",
      );
      return { handled: true, outcome: "denied" };
    }

    req.sendReply(NEW_COMMAND_SUCCESS).catch(() => {
      // fire-and-forget. Callers log send failures at their own level.
    });
  } catch (err) {
    logger.error(
      { err, conversationExternalId },
      "Failed to reset conversation for /new command",
    );
    req.sendNotice(NEW_COMMAND_ERROR);
    return { handled: true, outcome: "unavailable" };
  }
  return { handled: true, outcome: "reset" };
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
