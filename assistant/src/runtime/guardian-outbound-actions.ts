/**
 * Shared outbound guardian verification action logic.
 *
 * These pure functions encapsulate the business logic for starting, resending,
 * and cancelling outbound guardian verification flows (SMS, Telegram, voice).
 * They return transport-agnostic result objects and are consumed by both the
 * IPC handler (config-channels.ts) and the HTTP route layer (integration-routes.ts).
 */

import { createHash, randomBytes } from "node:crypto";

import { startGuardianVerificationCall } from "../calls/call-domain.js";
import type { ChannelId } from "../channels/types.js";
import { getGatewayInternalBaseUrl } from "../config/env.js";
import { sendMessage as sendSms } from "../messaging/providers/sms/client.js";
import { getCredentialMetadata } from "../tools/credentials/metadata-store.js";
import { getLogger } from "../util/logger.js";
import { normalizePhoneNumber } from "../util/phone.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { mintDaemonDeliveryToken } from "./auth/token-service.js";
import {
  countRecentSendsToDestination,
  createOutboundSession,
  findActiveSession,
  getGuardianBinding,
  updateSessionDelivery,
  updateSessionStatus,
} from "./channel-guardian-service.js";
import {
  composeVerificationSlack,
  composeVerificationSms,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "./guardian-verification-templates.js";

const log = getLogger("guardian-outbound-actions");

// ---------------------------------------------------------------------------
// Rate limit constants for outbound verification
// ---------------------------------------------------------------------------

/** Maximum SMS sends per verification session. */
export const MAX_SENDS_PER_SESSION = 5;

/** Cooldown between resends in milliseconds (15 seconds). */
export const RESEND_COOLDOWN_MS = 15_000;

/** Maximum sends per destination within a rolling window. */
export const MAX_SENDS_PER_DESTINATION_WINDOW = 10;

/** Rolling window for destination rate limit in milliseconds (1 hour). */
export const DESTINATION_RATE_WINDOW_MS = 3_600_000;

/** Session TTL in seconds (matches challenge TTL of 10 minutes). */
const SESSION_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Telegram destination classification
// ---------------------------------------------------------------------------

/**
 * Check whether a destination looks like a numeric Telegram chat ID.
 * Numeric chat IDs are plain integer strings (possibly negative for groups).
 */
function isTelegramChatId(destination: string): boolean {
  return /^-?\d+$/.test(destination);
}

/**
 * Normalize a Telegram destination for consistent rate-limit lookups.
 * Strips leading '@' and lowercases handles so that "@Username" and
 * "@username" count against the same per-destination rate window.
 * Numeric chat IDs are returned as-is.
 */
export function normalizeTelegramDestination(destination: string): string {
  if (isTelegramChatId(destination)) return destination;
  return destination.replace(/^@/, "").toLowerCase();
}

/**
 * Get the Telegram bot username from credential metadata.
 * Falls back to process.env.TELEGRAM_BOT_USERNAME.
 */
function getTelegramBotUsername(): string | undefined {
  const meta = getCredentialMetadata("telegram", "bot_token");
  if (
    meta?.accountInfo &&
    typeof meta.accountInfo === "string" &&
    meta.accountInfo.trim().length > 0
  ) {
    return meta.accountInfo.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface StartOutboundParams {
  channel: ChannelId;
  destination?: string;
  rebind?: boolean;
  /** Origin conversation ID so completion/failure pointers can route back. */
  originConversationId?: string;
}

export interface ResendOutboundParams {
  channel: ChannelId;
  /** Origin conversation ID so completion/failure pointers can route back on resend. */
  originConversationId?: string;
}

export interface CancelOutboundParams {
  channel: ChannelId;
}

/**
 * Transport-agnostic result object returned by outbound actions.
 * Maps 1:1 with the fields in GuardianVerificationResponse minus the IPC
 * `type` discriminant.
 */
export interface OutboundActionResult {
  success: boolean;
  error?: string;
  message?: string;
  channel?: ChannelId;
  verificationSessionId?: string;
  secret?: string;
  expiresAt?: number;
  nextResendAt?: number;
  sendCount?: number;
  telegramBootstrapUrl?: string;
  pendingBootstrap?: boolean;
  /** Echoed back so consumers know which conversation to target for pointers. */
  originConversationId?: string;
}

// ---------------------------------------------------------------------------
// SMS delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification SMS via the gateway. Fire-and-forget with error
 * logging -- the response is returned before delivery completes because
 * the caller should not be blocked on Twilio API latency.
 */
export function deliverVerificationSms(
  to: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = mintDaemonDeliveryToken();
      await sendSms(gatewayUrl, bearerToken, to, text, assistantId);
      log.info({ to, assistantId }, "Verification SMS delivered");
    } catch (err) {
      log.error({ err, to, assistantId }, "Failed to deliver verification SMS");
    }
  })();
}

// ---------------------------------------------------------------------------
// Telegram delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Telegram message via the gateway's /deliver/telegram
 * endpoint. Fire-and-forget with error logging.
 */
export function deliverVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
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
          "Gateway /deliver/telegram failed for verification",
        );
      } else {
        log.info(
          { chatId, assistantId },
          "Verification Telegram message delivered",
        );
      }
    } catch (err) {
      log.error(
        { err, chatId, assistantId },
        "Failed to deliver verification Telegram message",
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Voice call delivery helper
// ---------------------------------------------------------------------------

/**
 * Initiate an outbound Twilio call to the guardian's phone for voice
 * verification. Fire-and-forget with error logging.
 */
function initiateGuardianVoiceCall(
  phoneNumber: string,
  guardianVerificationSessionId: string,
  assistantId: string,
  originConversationId?: string,
): void {
  (async () => {
    try {
      const result = await startGuardianVerificationCall({
        phoneNumber,
        guardianVerificationSessionId,
        assistantId,
        originConversationId,
      });
      if (result.ok) {
        log.info(
          {
            phoneNumber,
            guardianVerificationSessionId,
            callSid: result.callSid,
          },
          "Guardian verification call initiated",
        );
      } else {
        log.error(
          { phoneNumber, guardianVerificationSessionId, error: result.error },
          "Failed to initiate guardian verification call",
        );
      }
    } catch (err) {
      log.error(
        { err, phoneNumber, guardianVerificationSessionId },
        "Failed to initiate guardian verification call",
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Start outbound
// ---------------------------------------------------------------------------

export async function startOutbound(
  params: StartOutboundParams,
): Promise<OutboundActionResult> {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const channel = params.channel;
  const originConversationId = params.originConversationId;

  if (channel === "sms") {
    return startOutboundSms(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "telegram") {
    return await startOutboundTelegram(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "voice") {
    return startOutboundVoice(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "slack") {
    return startOutboundSlack(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  }

  return {
    success: false,
    error: "unsupported_channel",
    message: `Outbound verification is only supported for SMS, Telegram, voice, and Slack. Got: ${channel}`,
    channel,
  };
}

function startOutboundSms(
  rawDestination: string | undefined,
  assistantId: string,
  channel: ChannelId,
  rebind?: boolean,
  originConversationId?: string,
): OutboundActionResult {
  if (!rawDestination) {
    return {
      success: false,
      error: "missing_destination",
      message:
        "A destination phone number is required for outbound SMS verification.",
      channel,
    };
  }

  const destination = normalizePhoneNumber(rawDestination);
  if (!destination) {
    return {
      success: false,
      error: "invalid_destination",
      message:
        "Could not parse phone number. Please enter a valid number (e.g. +15551234567, (555) 123-4567, or 555-123-4567).",
      channel,
    };
  }

  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = countRecentSendsToDestination(
    channel,
    destination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this phone number. Please try again later.",
      channel,
    };
  }

  const sessionResult = createOutboundSession({
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
    verificationPurpose: "guardian",
  });

  const smsBody = composeVerificationSms(
    GUARDIAN_VERIFY_TEMPLATE_KEYS.CHALLENGE_REQUEST,
    {
      code: sessionResult.secret,
      expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
    },
  );

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  const sendCount = 1;

  updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);
  deliverVerificationSms(destination, smsBody, assistantId);

  return {
    success: true,
    verificationSessionId: sessionResult.sessionId,
    secret: sessionResult.secret,
    expiresAt: sessionResult.expiresAt,
    nextResendAt,
    sendCount,
    channel,
    originConversationId,
  };
}

async function startOutboundTelegram(
  destination: string | undefined,
  assistantId: string,
  channel: ChannelId,
  rebind?: boolean,
  originConversationId?: string,
): Promise<OutboundActionResult> {
  if (!destination) {
    return {
      success: false,
      error: "missing_destination",
      message:
        "A destination (Telegram handle or chat ID) is required for outbound Telegram verification.",
      channel,
    };
  }

  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const normalizedDestination = normalizeTelegramDestination(destination);

  const recentSendCount = countRecentSendsToDestination(
    channel,
    normalizedDestination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this destination. Please try again later.",
      channel,
    };
  }

  if (isTelegramChatId(destination)) {
    const chatIdNum = parseInt(destination, 10);
    if (isNaN(chatIdNum) || chatIdNum < 0) {
      return {
        success: false,
        error: "invalid_destination",
        message:
          "Telegram group chats are not supported for verification. Use a private chat ID or @handle.",
        channel,
      };
    }

    const sessionResult = createOutboundSession({
      channel,
      expectedChatId: destination,
      identityBindingStatus: "bound",
      destinationAddress: normalizedDestination,
      verificationPurpose: "guardian",
    });

    const telegramBody = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
      {
        code: sessionResult.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const nextResendAt = now + RESEND_COOLDOWN_MS;
    const sendCount = 1;

    updateSessionDelivery(
      sessionResult.sessionId,
      now,
      sendCount,
      nextResendAt,
    );
    deliverVerificationTelegram(destination, telegramBody, assistantId);

    return {
      success: true,
      verificationSessionId: sessionResult.sessionId,
      secret: sessionResult.secret,
      expiresAt: sessionResult.expiresAt,
      nextResendAt,
      sendCount,
      channel,
      originConversationId,
    };
  }

  // Telegram handle/username: create a pending_bootstrap session with deep-link
  const { ensureTelegramBotUsernameResolved } =
    await import("./channel-invite-transports/telegram.js");
  await ensureTelegramBotUsernameResolved();
  const botUsername = getTelegramBotUsername();
  if (!botUsername) {
    return {
      success: false,
      error: "no_bot_username",
      message:
        "Telegram bot username is not configured. Set up the Telegram integration first.",
      channel,
    };
  }

  const bootstrapToken = randomBytes(16).toString("hex");
  const bootstrapTokenHash = createHash("sha256")
    .update(bootstrapToken)
    .digest("hex");

  const sessionResult = createOutboundSession({
    channel,
    identityBindingStatus: "pending_bootstrap",
    destinationAddress: normalizedDestination,
    bootstrapTokenHash,
    verificationPurpose: "guardian",
  });

  const telegramBootstrapUrl = `https://t.me/${botUsername}?start=gv_${bootstrapToken}`;

  return {
    success: true,
    verificationSessionId: sessionResult.sessionId,
    expiresAt: sessionResult.expiresAt,
    telegramBootstrapUrl,
    channel,
    originConversationId,
  };
}

function startOutboundVoice(
  rawDestination: string | undefined,
  assistantId: string,
  channel: ChannelId,
  rebind?: boolean,
  originConversationId?: string,
): OutboundActionResult {
  if (!rawDestination) {
    return {
      success: false,
      error: "missing_destination",
      message:
        "A destination phone number is required for outbound voice verification.",
      channel,
    };
  }

  const destination = normalizePhoneNumber(rawDestination);
  if (!destination) {
    return {
      success: false,
      error: "invalid_destination",
      message:
        "Could not parse phone number. Please enter a valid number (e.g. +15551234567, (555) 123-4567, or 555-123-4567).",
      channel,
    };
  }

  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = countRecentSendsToDestination(
    channel,
    destination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this phone number. Please try again later.",
      channel,
    };
  }

  const sessionResult = createOutboundSession({
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
    codeDigits: 6,
    verificationPurpose: "guardian",
  });

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  const sendCount = 1;

  updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);
  initiateGuardianVoiceCall(
    destination,
    sessionResult.sessionId,
    assistantId,
    originConversationId,
  );

  return {
    success: true,
    verificationSessionId: sessionResult.sessionId,
    secret: sessionResult.secret,
    expiresAt: sessionResult.expiresAt,
    nextResendAt,
    sendCount,
    channel,
    originConversationId,
  };
}

// ---------------------------------------------------------------------------
// Slack delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Slack DM via the gateway's /deliver/slack endpoint.
 * Fire-and-forget with error logging.
 */
export function deliverVerificationSlack(
  userId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = mintDaemonDeliveryToken();
      const url = `${gatewayUrl}/deliver/slack`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ chatId: userId, text, assistantId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "<unreadable>");
        log.error(
          { userId, assistantId, status: resp.status, body },
          "Gateway /deliver/slack failed for verification",
        );
      } else {
        log.info({ userId, assistantId }, "Verification Slack DM delivered");
      }
    } catch (err) {
      log.error(
        { err, userId, assistantId },
        "Failed to deliver verification Slack DM",
      );
    }
  })();
}

function startOutboundSlack(
  destination: string | undefined,
  assistantId: string,
  channel: ChannelId,
  rebind?: boolean,
  originConversationId?: string,
): OutboundActionResult {
  if (!destination) {
    return {
      success: false,
      error: "missing_destination",
      message: "A Slack user ID is required for outbound Slack verification.",
      channel,
    };
  }

  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = countRecentSendsToDestination(
    channel,
    destination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this Slack user. Please try again later.",
      channel,
    };
  }

  const sessionResult = createOutboundSession({
    channel,
    expectedExternalUserId: destination,
    expectedChatId: destination,
    identityBindingStatus: "bound",
    destinationAddress: destination,
    verificationPurpose: "guardian",
  });

  const slackBody = composeVerificationSlack(
    GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST,
    {
      code: sessionResult.secret,
      expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
    },
  );

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  const sendCount = 1;

  updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);
  deliverVerificationSlack(destination, slackBody, assistantId);

  return {
    success: true,
    verificationSessionId: sessionResult.sessionId,
    secret: sessionResult.secret,
    expiresAt: sessionResult.expiresAt,
    nextResendAt,
    sendCount,
    channel,
    originConversationId,
  };
}

// ---------------------------------------------------------------------------
// Resend outbound
// ---------------------------------------------------------------------------

export function resendOutbound(
  params: ResendOutboundParams,
): OutboundActionResult {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const channel = params.channel;
  const originConversationId = params.originConversationId;

  const session = findActiveSession(channel);
  if (!session) {
    return {
      success: false,
      error: "no_active_session",
      message: "No active outbound verification session found.",
      channel,
    };
  }

  if (session.identityBindingStatus === "pending_bootstrap") {
    return {
      success: false,
      error: "pending_bootstrap",
      message:
        "Cannot resend: waiting for bootstrap deep-link activation. The user must click the link first.",
      channel,
    };
  }

  if (session.nextResendAt != null && Date.now() < session.nextResendAt) {
    return {
      success: false,
      error: "rate_limited",
      message: "Please wait before requesting another verification code.",
      channel,
    };
  }

  const currentSendCount = session.sendCount ?? 0;
  if (currentSendCount >= MAX_SENDS_PER_SESSION) {
    return {
      success: false,
      error: "max_sends_exceeded",
      message: "Maximum number of verification sends reached for this session.",
      channel,
    };
  }

  const resendDestination =
    session.destinationAddress ??
    session.expectedPhoneE164 ??
    session.expectedChatId;
  if (resendDestination) {
    const recentDestSends = countRecentSendsToDestination(
      channel,
      resendDestination,
      DESTINATION_RATE_WINDOW_MS,
    );
    if (recentDestSends >= MAX_SENDS_PER_DESTINATION_WINDOW) {
      return {
        success: false,
        error: "rate_limited",
        message:
          "Too many verification attempts to this destination. Please try again later.",
        channel,
      };
    }
  }

  const destination =
    session.destinationAddress ??
    session.expectedPhoneE164 ??
    session.expectedChatId;
  if (!destination) {
    return {
      success: false,
      error: "no_destination",
      message: "Cannot resend: no destination address on the session.",
      channel,
    };
  }

  if (channel === "telegram") {
    const newSession = createOutboundSession({
      channel,
      expectedChatId: destination,
      identityBindingStatus: "bound",
      destinationAddress: destination,
      verificationPurpose: "guardian",
    });

    const telegramBody = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND,
      {
        code: newSession.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    updateSessionDelivery(
      newSession.sessionId,
      now,
      newSendCount,
      nextResendAt,
    );
    deliverVerificationTelegram(destination, telegramBody, assistantId);

    return {
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
    };
  } else if (channel === "voice") {
    const newSession = createOutboundSession({
      channel,
      expectedPhoneE164: destination,
      expectedExternalUserId: destination,
      destinationAddress: destination,
      codeDigits: 6,
      verificationPurpose: "guardian",
    });

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    updateSessionDelivery(
      newSession.sessionId,
      now,
      newSendCount,
      nextResendAt,
    );
    initiateGuardianVoiceCall(
      destination,
      newSession.sessionId,
      assistantId,
      originConversationId,
    );

    return {
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
    };
  } else if (channel === "slack") {
    const newSession = createOutboundSession({
      channel,
      expectedExternalUserId: destination,
      expectedChatId: destination,
      identityBindingStatus: "bound",
      destinationAddress: destination,
      verificationPurpose: "guardian",
    });

    const slackBody = composeVerificationSlack(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_RESEND,
      {
        code: newSession.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    updateSessionDelivery(
      newSession.sessionId,
      now,
      newSendCount,
      nextResendAt,
    );
    deliverVerificationSlack(destination, slackBody, assistantId);

    return {
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
    };
  }

  // SMS resend
  const newSession = createOutboundSession({
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
    verificationPurpose: "guardian",
  });

  const smsBody = composeVerificationSms(GUARDIAN_VERIFY_TEMPLATE_KEYS.RESEND, {
    code: newSession.secret,
    expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
  });

  const now = Date.now();
  const newSendCount = currentSendCount + 1;
  const nextResendAt = now + RESEND_COOLDOWN_MS;

  updateSessionDelivery(newSession.sessionId, now, newSendCount, nextResendAt);
  deliverVerificationSms(destination, smsBody, assistantId);

  return {
    success: true,
    verificationSessionId: newSession.sessionId,
    secret: newSession.secret,
    nextResendAt,
    sendCount: newSendCount,
    channel,
    originConversationId,
  };
}

// ---------------------------------------------------------------------------
// Cancel outbound
// ---------------------------------------------------------------------------

export function cancelOutbound(
  params: CancelOutboundParams,
): OutboundActionResult {
  const channel = params.channel;

  const session = findActiveSession(channel);
  if (!session) {
    return {
      success: false,
      error: "no_active_session",
      message: "No active outbound verification session found.",
      channel,
    };
  }

  updateSessionStatus(session.id, "revoked");

  return {
    success: true,
    channel,
  };
}
