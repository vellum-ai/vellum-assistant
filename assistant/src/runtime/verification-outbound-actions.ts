/**
 * Shared outbound verification action logic.
 *
 * These functions encapsulate the business logic for starting, resending,
 * and cancelling outbound verification flows (Telegram, voice, Slack, Discord,
 * email).
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
import { openDiscordDmChannel } from "../messaging/providers/discord/api.js";
import { sendDiscordReply } from "../messaging/providers/discord/send.js";
import { sendSlackReply } from "../messaging/providers/slack/send.js";
import { sendTelegramReply } from "../messaging/providers/telegram-bot/send.js";
import { getTelegramBotUsername } from "../telegram/bot-username.js";
import { getLogger } from "../util/logger.js";
import { normalizePhoneNumber } from "../util/phone.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { isGuardianBoundForChannel } from "./channel-verification-service.js";
import {
  composeVerificationText,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
  type TextVerifyTemplateKey,
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
  if (isTelegramChatId(destination)) {
    return destination;
  }
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
  }

  const spec = textChannelSpec(channel);
  if (spec) {
    return await startOutboundTextChannel(
      spec,
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
    message: `Outbound verification is not supported for ${channel}. Supported channels: Telegram, phone, Slack, Discord, email.`,
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

    const telegramBody = composeVerificationText(
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
// Discord delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Discord DM via the Discord REST API directly.
 * Fire-and-forget wrapper for use in the daemon process (HTTP route handlers).
 *
 * The recipient is a Discord *user* snowflake. Discord has no route that looks
 * up an existing DM by recipient, so the channel is opened on the way through
 * (see `openDiscordDmChannel`), and a user with DMs closed to server members
 * fails here rather than at the gate.
 */
export function deliverVerificationDiscord(
  userId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const channelId = await openDiscordDmChannel(userId);
      await sendDiscordReply({ channelId }, text);
      log.info({ userId, assistantId }, "Verification Discord DM delivered");
    } catch (err) {
      log.error(
        { err, userId, assistantId },
        "Failed to deliver verification Discord DM",
      );
    }
  })();
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

/**
 * The per-channel differences between the text-channel verification starts.
 *
 * Slack, Discord and email run the identical sequence: refuse without a
 * destination, refuse when a guardian is already bound, check the destination
 * rate window, mint a session, compose from a template, stamp the delivery,
 * send. The spec carries only the per-channel fields; the sequence itself
 * lives once in `startOutboundTextChannel`.
 *
 * Telegram and voice are deliberately absent. Telegram forks on whether the
 * destination is a chat id or a handle, and a handle mints a bootstrap session
 * carrying no code at all; voice normalizes a phone number and places a call
 * rather than composing a message. Folding either in would mean a spec field
 * that only one channel ever sets.
 */
interface TextChannelVerificationSpec {
  /** Rejection copy when the caller supplied no destination. */
  missingDestination: string;
  /** Rejection copy when the destination's rate window is exhausted. */
  rateLimited: string;
  /** Canonical form of the destination, for rate-limit keying and delivery. */
  normalizeDestination?: (destination: string) => string;
  /**
   * Identity the consume path will require.
   *
   * Where a channel sets `expectedChatId`, it does no work: `checkIdentityMatch`
   * requires the `expectedExternalUserId` match whenever both are set, and the
   * resend path resolves its destination from `destinationAddress` first. See
   * LUM-3110 for the wider question of session fields that record something
   * nothing reads.
   */
  sessionIdentity: (destination: string) => {
    expectedExternalUserId: string;
    expectedChatId?: string;
  };
  challengeTemplateKey: TextVerifyTemplateKey;
  resendTemplateKey: TextVerifyTemplateKey;
  /** Fire-and-forget delivery. Throwing is the transport's business, not this file's. */
  deliver: (destination: string, text: string, assistantId: string) => void;
}

const TEXT_CHANNEL_VERIFICATION: Partial<
  Record<ChannelId, TextChannelVerificationSpec>
> = {
  slack: {
    missingDestination:
      "A Slack user ID is required for outbound Slack verification.",
    rateLimited:
      "Too many verification attempts to this Slack user. Please try again later.",
    sessionIdentity: (destination) => ({
      expectedExternalUserId: destination,
      expectedChatId: destination,
    }),
    challengeTemplateKey: GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST,
    resendTemplateKey: GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_RESEND,
    deliver: deliverVerificationSlack,
  },
  discord: {
    missingDestination:
      "A Discord user ID is required for outbound Discord verification.",
    rateLimited:
      "Too many verification attempts to this Discord user. Please try again later.",
    // A Discord user snowflake is the session's only expected identity. There
    // is no chat id to record: the DM channel does not exist until it is
    // opened, and the guild channel the requester was seen in is a room rather
    // than a person, so binding to it would accept the code from anyone
    // standing in it.
    sessionIdentity: (destination) => ({
      expectedExternalUserId: destination,
    }),
    challengeTemplateKey:
      GUARDIAN_VERIFY_TEMPLATE_KEYS.DISCORD_CHALLENGE_REQUEST,
    resendTemplateKey: GUARDIAN_VERIFY_TEMPLATE_KEYS.DISCORD_RESEND,
    deliver: deliverVerificationDiscord,
  },
  email: {
    missingDestination:
      "An email address is required for outbound email verification.",
    rateLimited:
      "Too many verification attempts to this email address. Please try again later.",
    normalizeDestination: (destination) => destination.trim().toLowerCase(),
    sessionIdentity: (destination) => ({
      expectedExternalUserId: destination,
      expectedChatId: destination,
    }),
    challengeTemplateKey: GUARDIAN_VERIFY_TEMPLATE_KEYS.EMAIL_CHALLENGE_REQUEST,
    resendTemplateKey: GUARDIAN_VERIFY_TEMPLATE_KEYS.EMAIL_RESEND,
    deliver: (to, text, assistantId) =>
      deliverVerificationEmail(
        to,
        text,
        EMAIL_VERIFICATION_SUBJECT,
        assistantId,
      ),
  },
};

/**
 * The spec for a channel, or undefined when it has none.
 *
 * An own-property check rather than a bare index read: `channel` reaches here
 * as a plain string, so `"constructor"`, `"toString"` and `"__proto__"` would
 * otherwise resolve to inherited values, pass a truthy guard, and throw on the
 * first spec field instead of falling through to `unsupported_channel`. Same
 * fail-closed shape as `resolveCapabilities`.
 */
function textChannelSpec(
  channel: ChannelId,
): TextChannelVerificationSpec | undefined {
  return Object.prototype.hasOwnProperty.call(
    TEXT_CHANNEL_VERIFICATION,
    channel,
  )
    ? TEXT_CHANNEL_VERIFICATION[channel]
    : undefined;
}

/**
 * Mint a session, compose the message, stamp the delivery, and send it.
 *
 * Shared by the start and resend paths, which differ only in the template and
 * in how the send counters advance.
 */
interface MintedSend {
  sessionId: string;
  secret: string;
  expiresAt: number;
  nextResendAt: number;
}

async function mintAndSend(params: {
  spec: TextChannelVerificationSpec;
  channel: ChannelId;
  destination: string;
  templateKey: TextVerifyTemplateKey;
  sendCount: number;
  assistantId: string;
}): Promise<MintedSend> {
  const { spec, channel, destination, templateKey, sendCount, assistantId } =
    params;

  const session = await createOutboundSession({
    channel,
    ...spec.sessionIdentity(destination),
    identityBindingStatus: "bound",
    destinationAddress: destination,
    verificationPurpose: "guardian",
  });

  const body = composeVerificationText(templateKey, {
    code: session.secret,
    expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
  });

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  await updateSessionDelivery(session.sessionId, now, sendCount, nextResendAt);
  spec.deliver(destination, body, assistantId);

  return {
    sessionId: session.sessionId,
    secret: session.secret,
    expiresAt: session.expiresAt,
    nextResendAt,
  };
}

/**
 * Start outbound guardian verification on a channel that reaches its
 * destination with one text message.
 */
async function startOutboundTextChannel(
  spec: TextChannelVerificationSpec,
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
      message: spec.missingDestination,
      channel,
    };
  }
  const destination = spec.normalizeDestination
    ? spec.normalizeDestination(rawDestination)
    : rawDestination;

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
      message: spec.rateLimited,
      channel,
    };
  }

  const sent = await mintAndSend({
    spec,
    channel,
    destination,
    templateKey: spec.challengeTemplateKey,
    sendCount: 1,
    assistantId,
  });

  return {
    success: true,
    verificationSessionId: sent.sessionId,
    secret: sent.secret,
    expiresAt: sent.expiresAt,
    nextResendAt: sent.nextResendAt,
    sendCount: 1,
    channel,
    originConversationId,
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

  // Scoped to the guardian's own flow. A channel can carry a live session per
  // person verifying, so an unscoped lookup returns whoever started most
  // recently, which on a busy channel is a requester rather than the guardian
  // this resend is for.
  const session = await findActiveSession(channel, {
    verificationPurpose: "guardian",
  });
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

  const destination =
    session.destinationAddress ??
    session.expectedPhoneE164 ??
    session.expectedChatId;

  if (destination) {
    const recentDestSends = await countRecentSendsToDestination(
      channel,
      destination,
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

    const telegramBody = composeVerificationText(
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
  }

  const spec = textChannelSpec(channel);
  if (spec) {
    const newSendCount = currentSendCount + 1;
    const sent = await mintAndSend({
      spec,
      channel,
      destination,
      templateKey: spec.resendTemplateKey,
      sendCount: newSendCount,
      assistantId,
    });

    return {
      success: true,
      verificationSessionId: sent.sessionId,
      secret: sent.secret,
      nextResendAt: sent.nextResendAt,
      sendCount: newSendCount,
      channel,
      originConversationId,
    };
  }

  return {
    success: false,
    error: "unsupported_channel",
    message: `Resend is only supported for Telegram, phone, Slack, Discord, and email. Got: ${channel}`,
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

  // Scoped the same way as resend: cancelling the guardian's verification must
  // not revoke a requester's live session.
  const session = await findActiveSession(channel, {
    verificationPurpose: "guardian",
  });
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
