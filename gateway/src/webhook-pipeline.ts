import type { Logger } from "pino";
import type { ChannelId } from "./channels/types.js";
import type { GatewayConfig } from "./config.js";
import type { StringDedupCache } from "./dedup-cache.js";
import type { InboundResult } from "./handlers/handle-inbound.js";
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
 * Handles the /new command flow: resets the conversation and sends a
 * success or error reply via the provided callback.
 * Returns `{ handled: true }` in all cases since both success and error
 * are terminal for this message.
 */
export async function handleNewCommand(
  config: GatewayConfig,
  sourceChannel: ChannelId,
  conversationExternalId: string,
  sendReply: (text: string) => Promise<void>,
  logger: Logger,
): Promise<{ handled: true }> {
  try {
    await resetConversation(config, sourceChannel, conversationExternalId);
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

  if (result.verificationIntercepted) {
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
