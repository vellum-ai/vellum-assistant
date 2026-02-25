import { randomBytes, createHash } from 'node:crypto';
import * as net from 'node:net';

import * as externalConversationStore from '../../memory/external-conversation-store.js';
import {
  createVerificationChallenge,
  countRecentSendsToDestination,
  getGuardianBinding,
  getPendingChallenge,
  revokeBinding as revokeGuardianBinding,
  revokePendingChallenges,
  createOutboundSession,
  findActiveSession,
  updateSessionStatus,
  updateSessionDelivery,
} from '../../runtime/channel-guardian-service.js';
import { createReadinessService, type ChannelReadinessService } from '../../runtime/channel-readiness-service.js';
import {
  composeVerificationSms,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from '../../runtime/guardian-verification-templates.js';
import { startGuardianVerificationCall } from '../../calls/call-domain.js';
import { sendMessage as sendSms } from '../../messaging/providers/sms/client.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';
import { getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { normalizeAssistantId, readHttpToken } from '../../util/platform.js';
import type { ChannelId } from '../../channels/types.js';
import type {
  ChannelReadinessRequest,
  GuardianVerificationRequest,
} from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

// ---------------------------------------------------------------------------
// Rate limit constants for outbound verification
// ---------------------------------------------------------------------------

/** Maximum SMS sends per verification session. */
export const MAX_SENDS_PER_SESSION = 5;

/** Cooldown between resends in milliseconds (60 seconds). */
export const RESEND_COOLDOWN_MS = 60_000;

/** Maximum sends per destination within a rolling window. */
export const MAX_SENDS_PER_DESTINATION_WINDOW = 10;

/** Rolling window for destination rate limit in milliseconds (1 hour). */
export const DESTINATION_RATE_WINDOW_MS = 3_600_000;

/** Session TTL in seconds (matches challenge TTL of 10 minutes). */
const SESSION_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Readiness service singleton
// ---------------------------------------------------------------------------

// Lazy singleton — created on first use so module-load stays lightweight.
let _readinessService: ChannelReadinessService | undefined;
export function getReadinessService(): ChannelReadinessService {
  if (!_readinessService) {
    _readinessService = createReadinessService();
  }
  return _readinessService;
}

// ---------------------------------------------------------------------------
// E.164 validation
// ---------------------------------------------------------------------------

/**
 * Basic E.164 phone number validation: starts with +, followed by 10-15 digits.
 */
function isValidE164(phone: string): boolean {
  return /^\+\d{10,15}$/.test(phone);
}

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
 * Get the Telegram bot username from credential metadata.
 * Falls back to process.env.TELEGRAM_BOT_USERNAME.
 */
function getTelegramBotUsername(): string | undefined {
  const meta = getCredentialMetadata('telegram', 'bot_token');
  if (meta?.accountInfo && typeof meta.accountInfo === 'string' && meta.accountInfo.trim().length > 0) {
    return meta.accountInfo.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}

// ---------------------------------------------------------------------------
// Guardian verification handler
// ---------------------------------------------------------------------------

export function handleGuardianVerification(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Normalize the assistant ID so challenges are always stored under the
  // same key the inbound-call path will use for lookups (typically "self").
  const assistantId = normalizeAssistantId(msg.assistantId ?? 'self');
  const channel = msg.channel ?? 'telegram';

  try {
    if (msg.action === 'create_challenge') {
      // Fail by default if a guardian is already bound, unless the caller
      // explicitly opts in to rebinding by setting rebind: true.
      const existingBinding = getGuardianBinding(assistantId, channel);
      if (existingBinding && !msg.rebind) {
        ctx.send(socket, {
          type: 'guardian_verification_response',
          success: false,
          error: 'already_bound',
          message: 'A guardian is already bound for this channel. Revoke the existing binding first, or set rebind: true to replace.',
          channel,
        });
        return;
      }

      const result = createVerificationChallenge(assistantId, channel, msg.sessionId);

      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        secret: result.secret,
        instruction: result.instruction,
        channel,
      });
    } else if (msg.action === 'status') {
      const binding = getGuardianBinding(assistantId, channel);
      let guardianUsername: string | undefined;
      let guardianDisplayName: string | undefined;
      if (binding?.metadataJson) {
        try {
          const parsed = JSON.parse(binding.metadataJson) as Record<string, unknown>;
          if (typeof parsed.username === 'string' && parsed.username.trim().length > 0) {
            guardianUsername = parsed.username.trim();
          }
          if (typeof parsed.displayName === 'string' && parsed.displayName.trim().length > 0) {
            guardianDisplayName = parsed.displayName.trim();
          }
        } catch {
          // ignore malformed metadata
        }
      }
      if (binding?.guardianDeliveryChatId && (!guardianUsername || !guardianDisplayName)) {
        const ext = externalConversationStore.getBindingByChannelChat(
          channel,
          binding.guardianDeliveryChatId,
        );
        if (!guardianUsername && ext?.username) {
          guardianUsername = ext.username;
        }
        if (!guardianDisplayName && ext?.displayName) {
          guardianDisplayName = ext.displayName;
        }
      }
      const hasPendingChallenge = getPendingChallenge(assistantId, channel) != null;
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: binding != null,
        guardianExternalUserId: binding?.guardianExternalUserId,
        guardianUsername,
        guardianDisplayName,
        channel,
        assistantId,
        guardianDeliveryChatId: binding?.guardianDeliveryChatId,
        hasPendingChallenge,
      });
    } else if (msg.action === 'revoke') {
      revokeGuardianBinding(assistantId, channel);
      revokePendingChallenges(assistantId, channel);
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: true,
        bound: false,
        channel,
      });
    } else if (msg.action === 'start_outbound') {
      handleStartOutbound(msg, socket, ctx, assistantId, channel);
    } else if (msg.action === 'resend_outbound') {
      handleResendOutbound(msg, socket, ctx, assistantId, channel);
    } else if (msg.action === 'cancel_outbound') {
      handleCancelOutbound(socket, ctx, assistantId, channel);
    } else {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
        channel,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle guardian verification');
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: message,
      channel,
    });
  }
}

// ---------------------------------------------------------------------------
// Outbound verification action handlers
// ---------------------------------------------------------------------------

function handleStartOutbound(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  if (channel === 'sms') {
    handleStartOutboundSms(msg, socket, ctx, assistantId, channel);
  } else if (channel === 'telegram') {
    handleStartOutboundTelegram(msg, socket, ctx, assistantId, channel);
  } else if (channel === 'voice') {
    handleStartOutboundVoice(msg, socket, ctx, assistantId, channel);
  } else {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'unsupported_channel',
      message: `Outbound verification is only supported for SMS, Telegram, and voice. Got: ${channel}`,
      channel,
    });
  }
}

function handleStartOutboundSms(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  // Validate destination
  const destination = msg.destination;
  if (!destination) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'missing_destination',
      message: 'A destination phone number is required for outbound SMS verification.',
      channel,
    });
    return;
  }

  if (!isValidE164(destination)) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'invalid_destination',
      message: 'Destination must be a valid E.164 phone number (e.g. +15551234567).',
      channel,
    });
    return;
  }

  // Check for existing active binding (unless rebind=true)
  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !msg.rebind) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'already_bound',
      message: 'A guardian is already bound for this channel. Set rebind: true to replace.',
      channel,
    });
    return;
  }

  // Enforce per-destination rate limit across all sessions to prevent
  // circumvention by repeatedly calling start_outbound for the same number.
  const recentSendCount = countRecentSendsToDestination(channel, destination, DESTINATION_RATE_WINDOW_MS);
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'rate_limited',
      message: 'Too many verification attempts to this phone number. Please try again later.',
      channel,
    });
    return;
  }

  // Create outbound session with expected identity = E.164 destination
  const sessionResult = createOutboundSession({
    assistantId,
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
  });

  // Compose SMS using the challenge_request template
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

  // Update session delivery tracking
  updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);

  // Send SMS via the gateway's /deliver/sms endpoint (fire-and-forget with logging)
  deliverVerificationSms(destination, smsBody, assistantId);

  ctx.send(socket, {
    type: 'guardian_verification_response',
    success: true,
    verificationSessionId: sessionResult.sessionId,
    secret: sessionResult.secret,
    expiresAt: sessionResult.expiresAt,
    nextResendAt,
    sendCount,
    channel,
  });
}

function handleStartOutboundTelegram(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  const destination = msg.destination;
  if (!destination) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'missing_destination',
      message: 'A destination (Telegram handle or chat ID) is required for outbound Telegram verification.',
      channel,
    });
    return;
  }

  // Check for existing active binding (unless rebind=true)
  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !msg.rebind) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'already_bound',
      message: 'A guardian is already bound for this channel. Set rebind: true to replace.',
      channel,
    });
    return;
  }

  // Enforce per-destination rate limit across all sessions
  const recentSendCount = countRecentSendsToDestination(channel, destination, DESTINATION_RATE_WINDOW_MS);
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'rate_limited',
      message: 'Too many verification attempts to this destination. Please try again later.',
      channel,
    });
    return;
  }

  if (isTelegramChatId(destination)) {
    // Reject group chats (negative IDs) — verification must target a private chat
    const chatIdNum = parseInt(destination, 10);
    if (isNaN(chatIdNum) || chatIdNum < 0) {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: 'invalid_destination',
        message: 'Telegram group chats are not supported for verification. Use a private chat ID or @handle.',
        channel,
      });
      return;
    }

    // Known numeric chat ID: create a bound session and send message immediately
    const sessionResult = createOutboundSession({
      assistantId,
      channel,
      expectedChatId: destination,
      identityBindingStatus: 'bound',
      destinationAddress: destination,
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

    updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);

    deliverVerificationTelegram(destination, telegramBody, assistantId);

    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: true,
      verificationSessionId: sessionResult.sessionId,
      secret: sessionResult.secret,
      expiresAt: sessionResult.expiresAt,
      nextResendAt,
      sendCount,
      channel,
    });
  } else {
    // Telegram handle/username: create a pending_bootstrap session with deep-link
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: 'no_bot_username',
        message: 'Telegram bot username is not configured. Set up the Telegram integration first.',
        channel,
      });
      return;
    }

    // Generate a 16-byte random bootstrap token
    const bootstrapToken = randomBytes(16).toString('hex');
    const bootstrapTokenHash = createHash('sha256').update(bootstrapToken).digest('hex');

    const sessionResult = createOutboundSession({
      assistantId,
      channel,
      identityBindingStatus: 'pending_bootstrap',
      destinationAddress: destination,
      bootstrapTokenHash,
    });

    const telegramBootstrapUrl = `https://t.me/${botUsername}?start=gv_${bootstrapToken}`;

    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      telegramBootstrapUrl,
      channel,
    });
  }
}

function handleStartOutboundVoice(
  msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  const destination = msg.destination;
  if (!destination) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'missing_destination',
      message: 'A destination phone number is required for outbound voice verification.',
      channel,
    });
    return;
  }

  if (!isValidE164(destination)) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'invalid_destination',
      message: 'Destination must be a valid E.164 phone number (e.g. +15551234567).',
      channel,
    });
    return;
  }

  // Check for existing active binding (unless rebind=true)
  const existingBinding = getGuardianBinding(assistantId, channel);
  if (existingBinding && !msg.rebind) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'already_bound',
      message: 'A guardian is already bound for this channel. Set rebind: true to replace.',
      channel,
    });
    return;
  }

  // Enforce per-destination rate limit
  const recentSendCount = countRecentSendsToDestination(channel, destination, DESTINATION_RATE_WINDOW_MS);
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'rate_limited',
      message: 'Too many verification attempts to this phone number. Please try again later.',
      channel,
    });
    return;
  }

  // Create outbound session with 6-digit code for voice
  const sessionResult = createOutboundSession({
    assistantId,
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
    codeDigits: 6,
  });

  const now = Date.now();
  const nextResendAt = now + RESEND_COOLDOWN_MS;
  const sendCount = 1;

  updateSessionDelivery(sessionResult.sessionId, now, sendCount, nextResendAt);

  // Initiate the outbound Twilio call (fire-and-forget)
  initiateGuardianVoiceCall(destination, sessionResult.sessionId, assistantId);

  ctx.send(socket, {
    type: 'guardian_verification_response',
    success: true,
    verificationSessionId: sessionResult.sessionId,
    secret: sessionResult.secret,
    expiresAt: sessionResult.expiresAt,
    nextResendAt,
    sendCount,
    channel,
  });
}

function handleResendOutbound(
  _msg: GuardianVerificationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  // Find active session
  const session = findActiveSession(assistantId, channel);
  if (!session) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'no_active_session',
      message: 'No active outbound verification session found.',
      channel,
    });
    return;
  }

  // Pending bootstrap sessions cannot be resent — the user must click the deep link first
  if (session.identityBindingStatus === 'pending_bootstrap') {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'pending_bootstrap',
      message: 'Cannot resend: waiting for bootstrap deep-link activation. The user must click the link first.',
      channel,
    });
    return;
  }

  // Check resend cooldown (use generic error to avoid leaking timing info)
  if (session.nextResendAt != null && Date.now() < session.nextResendAt) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'rate_limited',
      message: 'Please wait before requesting another verification code.',
      channel,
    });
    return;
  }

  // Check send count cap
  const currentSendCount = session.sendCount ?? 0;
  if (currentSendCount >= MAX_SENDS_PER_SESSION) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'max_sends_exceeded',
      message: 'Maximum number of verification sends reached for this session.',
      channel,
    });
    return;
  }

  // We need the secret to compose the resend message, but the store only
  // persists the challenge hash. Create a new outbound session to get a fresh code.
  // This revokes the prior session automatically (via createOutboundSession internals).
  const destination = session.destinationAddress ?? session.expectedPhoneE164 ?? session.expectedChatId;
  if (!destination) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'no_destination',
      message: 'Cannot resend: no destination address on the session.',
      channel,
    });
    return;
  }

  if (channel === 'telegram') {
    // Create fresh session for Telegram resend
    const newSession = createOutboundSession({
      assistantId,
      channel,
      expectedChatId: destination,
      identityBindingStatus: 'bound',
      destinationAddress: destination,
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

    updateSessionDelivery(newSession.sessionId, now, newSendCount, nextResendAt);
    deliverVerificationTelegram(destination, telegramBody, assistantId);

    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: true,
      verificationSessionId: newSession.sessionId,
      nextResendAt,
      sendCount: newSendCount,
      channel,
    });
  } else if (channel === 'voice') {
    // Voice resend: create fresh session and initiate a new call
    const newSession = createOutboundSession({
      assistantId,
      channel,
      expectedPhoneE164: destination,
      expectedExternalUserId: destination,
      destinationAddress: destination,
      codeDigits: 6,
    });

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    updateSessionDelivery(newSession.sessionId, now, newSendCount, nextResendAt);
    initiateGuardianVoiceCall(destination, newSession.sessionId, assistantId);

    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: true,
      verificationSessionId: newSession.sessionId,
      secret: newSession.secret,
      nextResendAt,
      sendCount: newSendCount,
      channel,
    });
  } else {
    // SMS resend (existing behavior)
    const newSession = createOutboundSession({
      assistantId,
      channel,
      expectedPhoneE164: destination,
      expectedExternalUserId: destination,
      destinationAddress: destination,
    });

    const smsBody = composeVerificationSms(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.RESEND,
      {
        code: newSession.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const newSendCount = currentSendCount + 1;
    const nextResendAt = now + RESEND_COOLDOWN_MS;

    updateSessionDelivery(newSession.sessionId, now, newSendCount, nextResendAt);
    deliverVerificationSms(destination, smsBody, assistantId);

    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: true,
      verificationSessionId: newSession.sessionId,
      nextResendAt,
      sendCount: newSendCount,
      channel,
    });
  }
}

function handleCancelOutbound(
  socket: net.Socket,
  ctx: HandlerContext,
  assistantId: string,
  channel: ChannelId,
): void {
  const session = findActiveSession(assistantId, channel);
  if (!session) {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'no_active_session',
      message: 'No active outbound verification session found.',
      channel,
    });
    return;
  }

  updateSessionStatus(session.id, 'revoked');

  ctx.send(socket, {
    type: 'guardian_verification_response',
    success: true,
    channel,
  });
}

// ---------------------------------------------------------------------------
// SMS delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification SMS via the gateway. Fire-and-forget with error
 * logging — the IPC response is sent before delivery completes because
 * the caller should not be blocked on Twilio API latency.
 */
function deliverVerificationSms(
  to: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = readHttpToken();
      if (!bearerToken) {
        log.error('Cannot deliver verification SMS: no runtime HTTP token available');
        return;
      }
      await sendSms(gatewayUrl, bearerToken, to, text, assistantId);
      log.info({ to, assistantId }, 'Verification SMS delivered');
    } catch (err) {
      log.error({ err, to, assistantId }, 'Failed to deliver verification SMS');
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
function deliverVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = readHttpToken();
      if (!bearerToken) {
        log.error('Cannot deliver verification Telegram message: no runtime HTTP token available');
        return;
      }
      const url = `${gatewayUrl}/deliver/telegram`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ chatId, text, assistantId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '<unreadable>');
        log.error({ chatId, assistantId, status: resp.status, body }, 'Gateway /deliver/telegram failed for verification');
      } else {
        log.info({ chatId, assistantId }, 'Verification Telegram message delivered');
      }
    } catch (err) {
      log.error({ err, chatId, assistantId }, 'Failed to deliver verification Telegram message');
    }
  })();
}

// ---------------------------------------------------------------------------
// Voice call delivery helper
// ---------------------------------------------------------------------------

/**
 * Initiate an outbound Twilio call to the guardian's phone for voice
 * verification. Fire-and-forget with error logging — the IPC response
 * is sent before the call is placed.
 */
function initiateGuardianVoiceCall(
  phoneNumber: string,
  guardianVerificationSessionId: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const result = await startGuardianVerificationCall({
        phoneNumber,
        guardianVerificationSessionId,
        assistantId,
      });
      if (result.ok) {
        log.info({ phoneNumber, guardianVerificationSessionId, callSid: result.callSid }, 'Guardian verification call initiated');
      } else {
        log.error({ phoneNumber, guardianVerificationSessionId, error: result.error }, 'Failed to initiate guardian verification call');
      }
    } catch (err) {
      log.error({ err, phoneNumber, guardianVerificationSessionId }, 'Failed to initiate guardian verification call');
    }
  })();
}

// ---------------------------------------------------------------------------
// Channel readiness handler
// ---------------------------------------------------------------------------

export async function handleChannelReadiness(
  msg: ChannelReadinessRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const service = getReadinessService();

    if (msg.action === 'refresh') {
      if (msg.channel) {
        service.invalidateChannel(msg.channel, msg.assistantId);
      } else {
        service.invalidateAll();
      }
    }

    const snapshots = await service.getReadiness(msg.channel, msg.includeRemote, msg.assistantId);

    ctx.send(socket, {
      type: 'channel_readiness_response',
      success: true,
      snapshots: snapshots.map((s) => ({
        channel: s.channel,
        ready: s.ready,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle channel readiness');
    ctx.send(socket, {
      type: 'channel_readiness_response',
      success: false,
      error: message,
    });
  }
}

export const channelHandlers = defineHandlers({
  channel_readiness: handleChannelReadiness,
  guardian_verification: handleGuardianVerification,
});
