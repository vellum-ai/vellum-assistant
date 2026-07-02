/**
 * Bootstrap deep-link intercept stage: handles Telegram /start gv_<token>
 * commands that initiate the guardian verification bootstrap flow.
 *
 * When a user clicks the deep link, Telegram sends /start gv_<token> which
 * the gateway forwards with commandIntent: { type: 'start', payload: 'gv_<token>' }.
 * This module resolves the bootstrap token, binds the session identity, creates
 * a new identity-bound session with a fresh verification code, sends it, and
 * returns an early response.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type {
  CreateOutboundSessionResult,
  VerificationSessionWire,
} from "../../../channels/gateway-verification-sessions.js";
import {
  bindSessionIdentity,
  createOutboundSessionConditional,
  resolveBootstrapToken,
  updateSessionDelivery,
} from "../../../channels/gateway-verification-sessions.js";
import type { ChannelId } from "../../../channels/types.js";
import { sendTelegramReply } from "../../../messaging/providers/telegram-bot/send.js";
import { getLogger } from "../../../util/logger.js";
import { RESEND_COOLDOWN_MS } from "../../verification-outbound-actions.js";
import {
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../../verification-templates.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BootstrapInterceptParams {
  isDuplicate: boolean;
  commandIntent: Record<string, unknown> | undefined;
  rawSenderId: string | undefined;
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  eventId: string;
  /**
   * Session already resolved by ACL enforcement for this token. When set,
   * the admission floor was skipped on its strength; this stage reuses it
   * instead of re-resolving via the gateway.
   */
  validatedBootstrapSession?: VerificationSessionWire;
}

const BOOTSTRAP_UNAVAILABLE_REPLY =
  "I couldn't process your verification link just now. Please tap the link again in a moment.";

/**
 * Deterministic handled response for gateway failures mid-bootstrap. ACL may
 * have skipped the admission floor for this token, so a gv_ command must
 * never fall through to normal processing on a transient gateway failure.
 */
async function respondBootstrapUnavailable(
  conversationExternalId: string,
  eventId: string,
): Promise<Record<string, unknown>> {
  try {
    await sendTelegramReply(conversationExternalId, BOOTSTRAP_UNAVAILABLE_REPLY);
  } catch (err) {
    log.error(
      { err, chatId: conversationExternalId },
      "Failed to deliver bootstrap unavailable reply",
    );
  }
  return {
    accepted: true,
    duplicate: false,
    eventId,
    verificationOutcome: "bootstrap_unavailable",
  };
}

/**
 * Intercept /start gv_<token> bootstrap deep-link commands.
 *
 * Returns a Response if the bootstrap was handled, or null to continue
 * the pipeline.
 */
export async function handleBootstrapIntercept(
  params: BootstrapInterceptParams,
): Promise<Record<string, unknown> | null> {
  const {
    isDuplicate,
    commandIntent,
    rawSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    eventId,
    validatedBootstrapSession,
  } = params;

  if (
    isDuplicate ||
    commandIntent?.type !== "start" ||
    typeof commandIntent.payload !== "string" ||
    !(commandIntent.payload as string).startsWith("gv_") ||
    !rawSenderId
  ) {
    return null;
  }

  // Sessions live in the gateway. When ACL already validated this token it
  // threads the session through — no second lookup. Otherwise resolve here;
  // a gateway failure must never fall through to normal processing (the
  // floor may have been skipped), so degrade to a handled "try again" reply.
  const bootstrapToken = (commandIntent.payload as string).slice(3);
  let bootstrapSession: VerificationSessionWire | null;
  if (validatedBootstrapSession) {
    bootstrapSession = validatedBootstrapSession;
  } else {
    try {
      bootstrapSession = await resolveBootstrapToken(
        sourceChannel,
        bootstrapToken,
      );
    } catch (err) {
      log.warn(
        { err, sourceChannel },
        "Bootstrap intercept: token resolution failed (gateway unreachable)",
      );
      return respondBootstrapUnavailable(conversationExternalId, eventId);
    }
  }

  if (!bootstrapSession || bootstrapSession.status !== "pending_bootstrap") {
    // Not found or expired — fall through to normal /start handling. Only
    // reachable when ACL did not validate the token (a threaded session is
    // always pending_bootstrap), so the admission floor already ran.
    return null;
  }

  let minted: Awaited<ReturnType<typeof createOutboundSessionConditional>>;
  try {
    // Bind the pending_bootstrap session to the sender's identity. Binding
    // leaves status untouched, so a failure anywhere before the mint keeps
    // the token resolvable and the deep link retryable.
    await bindSessionIdentity(
      bootstrapSession.id,
      rawSenderId,
      conversationExternalId,
    );

    // Mint the identity-bound replacement with a fresh secret. The gateway
    // revokes the bootstrap session in the same call, so a successful mint
    // is what consumes the token — no separate status transition needed.
    // requireSourceSessionPending makes the claim atomic gateway-side: if a
    // concurrent /start for the same deep link already minted (revoking the
    // bootstrap session), this call conflicts instead of revoking the
    // winner's freshly sent code.
    minted = await createOutboundSessionConditional({
      channel: sourceChannel,
      expectedExternalUserId: rawSenderId,
      expectedChatId: conversationExternalId,
      identityBindingStatus: "bound",
      destinationAddress: conversationExternalId,
      requireSourceSessionPending: bootstrapSession.id,
    });
  } catch (err) {
    log.warn(
      { err, sourceChannel, sessionId: bootstrapSession.id },
      "Bootstrap intercept: session handoff failed (gateway unreachable)",
    );
    return respondBootstrapUnavailable(conversationExternalId, eventId);
  }

  if ("conflict" in minted) {
    // A concurrent /start already claimed this token and sent its code —
    // handled response, no new mint, no reply (the winner's code stands).
    log.info(
      { sourceChannel, sessionId: bootstrapSession.id, reason: minted.reason },
      "Bootstrap intercept: token already claimed by a concurrent handoff",
    );
    return {
      accepted: true,
      duplicate: false,
      eventId,
      verificationOutcome: "bootstrap_already_claimed",
    };
  }
  const newSession: CreateOutboundSessionResult = minted;

  // Compose and send the verification prompt via Telegram
  const telegramBody = composeVerificationTelegram(
    GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
    {
      code: newSession.secret,
      expiresInMinutes: Math.floor(
        (newSession.expiresAt - Date.now()) / 60_000,
      ),
    },
  );

  // Deliver verification Telegram message directly (fire-and-forget)
  deliverBootstrapVerificationTelegram(
    conversationExternalId,
    telegramBody,
    canonicalAssistantId,
  );

  // Update delivery tracking (best-effort — the code is already on its way)
  const now = Date.now();
  try {
    await updateSessionDelivery(
      newSession.sessionId,
      now,
      1,
      now + RESEND_COOLDOWN_MS,
    );
  } catch (err) {
    log.error(
      { err, sessionId: newSession.sessionId },
      "Bootstrap intercept: failed to update session delivery tracking",
    );
  }

  return ({
    accepted: true,
    duplicate: false,
    eventId,
    verificationOutcome: "bootstrap_bound",
  });
}

// ---------------------------------------------------------------------------
// Bootstrap verification Telegram delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Telegram message during bootstrap.
 * Fire-and-forget with error logging and a single self-retry on failure.
 */
function deliverBootstrapVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  const attemptDelivery = async (): Promise<boolean> => {
    try {
      await sendTelegramReply(chatId, text);
      return true;
    } catch (err) {
      log.error(
        { err, chatId, assistantId },
        "Failed to deliver bootstrap verification Telegram message",
      );
      return false;
    }
  };

  (async () => {
    const delivered = await attemptDelivery();
    if (delivered) {
      log.info(
        { chatId, assistantId },
        "Bootstrap verification Telegram message delivered",
      );
      return;
    }

    // Self-retry after a short delay. The gateway deduplicates inbound
    // webhooks after a successful forward, so duplicate retries from the
    // user re-clicking the deep link may never arrive. This ensures
    // delivery is re-attempted even without a gateway duplicate.
    setTimeout(async () => {
      const retried = await attemptDelivery();
      if (retried) {
        log.info(
          { chatId, assistantId },
          "Bootstrap verification Telegram message delivered on self-retry",
        );
      } else {
        log.error(
          { chatId, assistantId },
          "Bootstrap verification Telegram self-retry also failed",
        );
      }
    }, 3000);
  })();
}
