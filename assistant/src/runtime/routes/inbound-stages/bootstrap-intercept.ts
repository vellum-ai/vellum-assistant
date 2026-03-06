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
import type { ChannelId } from "../../../channels/types.js";
import { getGatewayInternalBaseUrl } from "../../../config/env.js";
import { getLogger } from "../../../util/logger.js";
import { mintDaemonDeliveryToken } from "../../auth/token-service.js";
import {
  bindSessionIdentity,
  createOutboundSession,
  resolveBootstrapToken,
  updateSessionDelivery,
  updateSessionStatus,
} from "../../channel-guardian-service.js";
import { RESEND_COOLDOWN_MS } from "../../guardian-outbound-actions.js";
import {
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../../guardian-verification-templates.js";

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
}

/**
 * Intercept /start gv_<token> bootstrap deep-link commands.
 *
 * Returns a Response if the bootstrap was handled, or null to continue
 * the pipeline.
 */
export async function handleBootstrapIntercept(
  params: BootstrapInterceptParams,
): Promise<Response | null> {
  const {
    isDuplicate,
    commandIntent,
    rawSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    eventId,
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

  const bootstrapToken = (commandIntent.payload as string).slice(3);
  const bootstrapSession = resolveBootstrapToken(sourceChannel, bootstrapToken);

  if (!bootstrapSession || bootstrapSession.status !== "pending_bootstrap") {
    // Not found or expired — fall through to normal /start handling
    return null;
  }

  // Bind the pending_bootstrap session to the sender's identity
  bindSessionIdentity(bootstrapSession.id, rawSenderId, conversationExternalId);

  // Transition bootstrap session to awaiting_response
  updateSessionStatus(bootstrapSession.id, "awaiting_response");

  // Create a new identity-bound outbound session with a fresh secret.
  // The old bootstrap session is auto-revoked by createOutboundSession.
  const newSession = createOutboundSession({
    channel: sourceChannel,
    expectedExternalUserId: rawSenderId,
    expectedChatId: conversationExternalId,
    identityBindingStatus: "bound",
    destinationAddress: conversationExternalId,
  });

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

  // Deliver verification Telegram message via the gateway (fire-and-forget)
  deliverBootstrapVerificationTelegram(
    conversationExternalId,
    telegramBody,
    canonicalAssistantId,
  );

  // Update delivery tracking
  const now = Date.now();
  updateSessionDelivery(newSession.sessionId, now, 1, now + RESEND_COOLDOWN_MS);

  return Response.json({
    accepted: true,
    duplicate: false,
    eventId,
    guardianVerification: "bootstrap_bound",
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
    const gatewayUrl = getGatewayInternalBaseUrl();
    const bearerToken = mintDaemonDeliveryToken();
    const url = `${gatewayUrl}/deliver/telegram`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ chatId, text, assistantId }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<unreadable>");
      log.error(
        { chatId, assistantId, status: resp.status, body },
        "Gateway /deliver/telegram failed for bootstrap verification",
      );
      return false;
    }
    return true;
  };

  (async () => {
    try {
      const delivered = await attemptDelivery();
      if (delivered) {
        log.info(
          { chatId, assistantId },
          "Bootstrap verification Telegram message delivered",
        );
        return;
      }
    } catch (err) {
      log.error(
        { err, chatId, assistantId },
        "Failed to deliver bootstrap verification Telegram message",
      );
    }

    // Self-retry after a short delay. The gateway deduplicates inbound
    // webhooks after a successful forward, so duplicate retries from the
    // user re-clicking the deep link may never arrive. This ensures
    // delivery is re-attempted even without a gateway duplicate.
    setTimeout(async () => {
      try {
        const delivered = await attemptDelivery();
        if (delivered) {
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
      } catch (retryErr) {
        log.error(
          { err: retryErr, chatId, assistantId },
          "Bootstrap verification Telegram self-retry threw; giving up",
        );
      }
    }, 3000);
  })();
}
