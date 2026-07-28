/**
 * Shared outbound verification action logic.
 *
 * These functions encapsulate the business logic for starting, resending,
 * and cancelling outbound verification flows (Telegram, voice, Slack, email).
 * They return transport-agnostic result objects and are consumed by both the
 * message handler (config-channels.ts) and the HTTP route layer (channel-verification-routes.ts).
 *
 * Session state is gateway-owned: lifecycle calls go through the gateway
 * session client and fail loudly when the gateway is unreachable (no local
 * fallback writes). Message composition and delivery stay daemon-side.
 */

import { randomBytes } from "node:crypto";

import { hashVerificationSecret } from "@vellumai/gateway-client";

import { startVerificationCall } from "../calls/call-domain.js";
import {
  countRecentSendsToDestination,
  createOutboundSession,
  findActiveSession,
  updateSessionDelivery,
  updateSessionStatus,
} from "../channels/gateway-verification-sessions.js";
import type { ChannelId } from "../channels/types.js";
import { sendSlackReply } from "../messaging/providers/slack/send.js";
import { sendTelegramReply } from "../messaging/providers/telegram-bot/send.js";
import { getTelegramBotUsername } from "../telegram/bot-username.js";
import { getLogger } from "../util/logger.js";
import { normalizePhoneNumber } from "../util/phone.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { isGuardianBoundForChannel } from "./channel-verification-service.js";
import {
  composeVerificationEmail,
  composeVerificationSlack,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "./verification-templates.js";

const log = getLogger("verification-outbound-actions");

// ---------------------------------------------------------------------------
// Rate limit constants for outbound verification
// ---------------------------------------------------------------------------

/** Maximum sends per verification session. */
export const MAX_SENDS_PER_SESSION = 5;

/** Cooldown between resends in milliseconds (15 seconds). */
export const RESEND_COOLDOWN_MS = 15_000;

/** Maximum sends per destination within a rolling window. */
export const MAX_SENDS_PER_DESTINATION_WINDOW = 10;

/** Rolling window for destination rate limit in milliseconds (1 hour). */
export const DESTINATION_RATE_WINDOW_MS = 3_600_000;

/** Session TTL in seconds (matches challenge TTL of 10 minutes). */
const SESSION_TTL_SECONDS = 600;

const EMAIL_VERIFICATION_SUBJECT = "Vellum Assistant Guardian Verification";

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

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

interface StartOutboundParams {
  channel: ChannelId;
  destination?: string;
  rebind?: boolean;
  /** Origin conversation ID so completion/failure pointers can route back. */
  originConversationId?: string;
}

interface ResendOutboundParams {
  channel: ChannelId;
  /** Origin conversation ID so completion/failure pointers can route back on resend. */
  originConversationId?: string;
}

interface CancelOutboundParams {
  channel: ChannelId;
}

/**
 * Transport-agnostic result object returned by outbound actions.
 * Maps 1:1 with the fields in ChannelVerificationSessionResponse minus the
 * `type` discriminant.
 */
interface OutboundActionResult {
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
  /** Internal: Slack DM delivery payload for the caller to dispatch.
   *  The shared startOutbound/resendOutbound functions no longer fire the
   *  delivery themselves because CLI subprocesses are sandboxed and cannot
   *  reach the gateway.  The daemon HTTP route handler calls
   *  deliverVerificationSlack() after receiving this payload. */
  _pendingSlackDm?: { userId: string; text: string; assistantId: string };
  /** Internal: email delivery payload for the caller to dispatch (same pattern as Slack). */
  _pendingEmail?: {
    to: string;
    text: string;
    subject: string;
    assistantId: string;
  };
}

// ---------------------------------------------------------------------------
// Telegram delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Telegram message via the Bot API directly.
 * Fire-and-forget with error logging.
 */
export function deliverVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      await sendTelegramReply(chatId, text);
      log.info(
        { chatId, assistantId },
        "Verification Telegram message delivered",
      );
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
  verificationSessionId: string,
  assistantId: string,
  originConversationId?: string,
): void {
  (async () => {
    try {
      const result = await startVerificationCall({
        phoneNumber,
        verificationSessionId,
        assistantId,
        originConversationId,
      });
      if (result.ok) {
        log.info(
          {
            phoneNumber,
            verificationSessionId,
            callSid: result.callSid,
          },
          "Guardian verification call initiated",
        );
      } else {
        log.error(
          { phoneNumber, verificationSessionId, error: result.error },
          "Failed to initiate guardian verification call",
        );
      }
    } catch (err) {
      log.error(
        { err, phoneNumber, verificationSessionId },
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

  if (channel === "telegram") {
    return await startOutboundTelegram(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "phone") {
    return await startOutboundVoice(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "slack") {
    return await startOutboundSlack(
      params.destination,
      assistantId,
      channel,
      params.rebind,
      originConversationId,
    );
  } else if (channel === "email") {
    return await startOutboundEmail(
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
    message: `Outbound verification is not supported for ${channel}. Supported channels: Telegram, phone, Slack, email.`,
    channel,
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

  const alreadyBound = await isGuardianBoundForChannel(channel);
  if (alreadyBound && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const normalizedDestination = normalizeTelegramDestination(destination);

  const recentSendCount = await countRecentSendsToDestination(
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

    const sessionResult = await createOutboundSession({
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

    await updateSessionDelivery(
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
  const bootstrapTokenHash = hashVerificationSecret(bootstrapToken);

  const sessionResult = await createOutboundSession({
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

async function startOutboundVoice(
  rawDestination: string | undefined,
  assistantId: string,
  channel: ChannelId,
  rebind?: boolean,
  originConversationId?: string,
): Promise<OutboundActionResult> {
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

  const alreadyBound = await isGuardianBoundForChannel(channel);
  if (alreadyBound && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = await countRecentSendsToDestination(
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

  const sessionResult = await createOutboundSession({
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

  await updateSessionDelivery(
    sessionResult.sessionId,
    now,
    sendCount,
    nextResendAt,
  );
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
 * Deliver a verification Slack DM via the Slack Web API directly.
 * Returns a promise that resolves when the delivery attempt completes.
 */
async function deliverVerificationSlackAsync(
  userId: string,
  text: string,
  assistantId: string,
): Promise<void> {
  try {
    await sendSlackReply(userId, text);
    log.info({ userId, assistantId }, "Verification Slack DM delivered");
  } catch (err) {
    log.error(
      { err, userId, assistantId },
      "Failed to deliver verification Slack DM",
    );
  }
}

/**
 * Deliver a verification Slack DM via the Slack Web API directly.
 * Fire-and-forget wrapper for use in the daemon process (HTTP route handlers).
 */
export function deliverVerificationSlack(
  userId: string,
  text: string,
  assistantId: string,
): void {
  deliverVerificationSlackAsync(userId, text, assistantId);
}

// ---------------------------------------------------------------------------
// Email delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification email via the platform email send API.
 * Fire-and-forget wrapper for use in the daemon process (HTTP route handlers).
 */
export function deliverVerificationEmail(
  to: string,
  text: string,
  subject: string,
  _assistantId: string,
): void {
  (async () => {
    try {
      const { VellumPlatformClient } = await import("../platform/client.js");
      const client = await VellumPlatformClient.create();
      if (!client?.platformAssistantId) {
        log.error(
          "Cannot deliver verification email: platform client not configured",
        );
        return;
      }

      const listResponse = await client.fetch(
        `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
      );
      if (!listResponse.ok) {
        log.error(
          { status: listResponse.status },
          "Failed to list email addresses for verification",
        );
        return;
      }
      const listData = (await listResponse.json()) as {
        results: { address: string }[];
      };
      const addresses = listData.results ?? [];
      if (addresses.length === 0) {
        log.error(
          "No email address registered — cannot deliver verification email",
        );
        return;
      }
      const fromAddress = addresses[0].address;

      const { markdownToEmailHtml } = await import("../email/html-renderer.js");
      const html = markdownToEmailHtml(text);

      const response = await client.fetch("/v1/runtime-proxy/email/send/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [to],
          from_address: fromAddress,
          text,
          subject,
          html,
        }),
      });

      if (response.ok) {
        log.info({ to }, "Verification email delivered");
      } else {
        const respBody = await response.json().catch(() => ({}));
        log.error(
          { to, status: response.status, respBody },
          "Failed to deliver verification email",
        );
      }
    } catch (err) {
      log.error({ err, to }, "Failed to deliver verification email");
    }
  })();
}

async function startOutboundSlack(
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
      message: "A Slack user ID is required for outbound Slack verification.",
      channel,
    };
  }

  const alreadyBound = await isGuardianBoundForChannel(channel);
  if (alreadyBound && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = await countRecentSendsToDestination(
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

  const sessionResult = await createOutboundSession({
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

  await updateSessionDelivery(
    sessionResult.sessionId,
    now,
    sendCount,
    nextResendAt,
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
    _pendingSlackDm: { userId: destination, text: slackBody, assistantId },
  };
}

async function startOutboundEmail(
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
      message: "An email address is required for outbound email verification.",
      channel,
    };
  }

  const normalizedEmail = destination.trim().toLowerCase();

  const alreadyBound = await isGuardianBoundForChannel(channel);
  if (alreadyBound && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Set rebind: true to replace.",
      channel,
    };
  }

  const recentSendCount = await countRecentSendsToDestination(
    channel,
    normalizedEmail,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this email address. Please try again later.",
      channel,
    };
  }

  const sessionResult = await createOutboundSession({
    channel,
    expectedExternalUserId: normalizedEmail,
    expectedChatId: normalizedEmail,
    identityBindingStatus: "bound",
    destinationAddress: normalizedEmail,
    verificationPurpose: "guardian",
  });

  const emailBody = composeVerificationEmail(
    GUARDIAN_VERIFY_TEMPLATE_KEYS.EMAIL_CHALLENGE_REQUEST,
    {
      code: sessionResult.secret,
      expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
    },
  );

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  const sendCount = 1;

  await updateSessionDelivery(
    sessionResult.sessionId,
    now,
    sendCount,
    nextResendAt,
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
    _pendingEmail: {
      to: normalizedEmail,
      text: emailBody,
      subject: EMAIL_VERIFICATION_SUBJECT,
      assistantId,
    },
  };
}

// ---------------------------------------------------------------------------
// Resend outbound
// ---------------------------------------------------------------------------

export async function resendOutbound(
  params: ResendOutboundParams,
): Promise<OutboundActionResult> {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const channel = params.channel;
  const originConversationId = params.originConversationId;

  const session = await findActiveSession(channel);
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
    const recentDestSends = await countRecentSendsToDestination(
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
    const newSession = await createOutboundSession({
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

    await updateSessionDelivery(
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
  } else if (channel === "phone") {
    const newSession = await createOutboundSession({
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

    await updateSessionDelivery(
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
    const newSession = await createOutboundSession({
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

    await updateSessionDelivery(
      newSession.sessionId,
      now,
      newSendCount,
      nextResendAt,
    );

    return {
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
      _pendingSlackDm: { userId: destination, text: slackBody, assistantId },
    };
  } else if (channel === "email") {
    const newSession = await createOutboundSession({
      channel,
      expectedExternalUserId: destination,
      expectedChatId: destination,
      identityBindingStatus: "bound",
      destinationAddress: destination,
      verificationPurpose: "guardian",
    });

    const emailBody = composeVerificationEmail(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.EMAIL_RESEND,
      {
        code: newSession.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    await updateSessionDelivery(
      newSession.sessionId,
      now,
      newSendCount,
      nextResendAt,
    );

    return {
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
      _pendingEmail: {
        to: destination,
        text: emailBody,
        subject: EMAIL_VERIFICATION_SUBJECT,
        assistantId,
      },
    };
  }

  return {
    success: false,
    error: "unsupported_channel",
    message: `Resend is only supported for Telegram, phone, Slack, and email. Got: ${channel}`,
    channel,
  };
}

// ---------------------------------------------------------------------------
// Cancel outbound
// ---------------------------------------------------------------------------

export async function cancelOutbound(
  params: CancelOutboundParams,
): Promise<OutboundActionResult> {
  const channel = params.channel;

  const session = await findActiveSession(channel);
  if (!session) {
    return {
      success: false,
      error: "no_active_session",
      message: "No active outbound verification session found.",
      channel,
    };
  }

  await updateSessionStatus(session.id, "revoked");

  return {
    success: true,
    channel,
  };
}
