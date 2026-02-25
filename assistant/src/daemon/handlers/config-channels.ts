import * as net from 'node:net';

import * as externalConversationStore from '../../memory/external-conversation-store.js';
import {
  createVerificationChallenge,
  getGuardianBinding,
  getPendingChallenge,
  revokeBinding as revokeGuardianBinding,
  revokePendingChallenges,
  createOutboundSession,
  findActiveSession,
  updateSessionStatus,
  updateSessionDelivery,
} from '../../runtime/channel-guardian-service.js';
import { type ChannelReadinessService, createReadinessService } from '../../runtime/channel-readiness-service.js';
import {
  composeVerificationSms,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from '../../runtime/guardian-verification-templates.js';
import { sendMessage as sendSms } from '../../messaging/providers/sms/client.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';
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
  // Only SMS is supported for this PR
  if (channel !== 'sms') {
    ctx.send(socket, {
      type: 'guardian_verification_response',
      success: false,
      error: 'unsupported_channel',
      message: `Outbound verification is only supported for SMS. Got: ${channel}`,
      channel,
    });
    return;
  }

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

  // Enforce rate limits across repeated start_outbound calls by checking
  // for an existing active session. Without this, callers could bypass
  // per-session rate limits by creating fresh sessions each time.
  const existingSession = findActiveSession(assistantId, channel);
  let carryForwardSendCount = 0;
  if (existingSession) {
    if (existingSession.nextResendAt != null && Date.now() < existingSession.nextResendAt) {
      ctx.send(socket, {
        type: 'guardian_verification_response',
        success: false,
        error: 'rate_limited',
        message: 'Please wait before requesting another verification code.',
        channel,
      });
      return;
    }

    const currentSendCount = existingSession.sendCount ?? 0;
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

    carryForwardSendCount = currentSendCount;
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
  const sendCount = carryForwardSendCount + 1;

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

  // We need the secret to compose the resend SMS, but the store only
  // persists the challenge hash. The createOutboundSession generated a fresh
  // secret when start_outbound was called and it was sent via SMS already.
  // For resend we cannot recover the original plaintext secret from the hash.
  // Instead, create a new outbound session to get a fresh code. This revokes
  // the prior session automatically (via createOutboundSession internals).
  const destination = session.destinationAddress ?? session.expectedPhoneE164;
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

  // Create a fresh session (auto-revokes prior one)
  const newSession = createOutboundSession({
    assistantId,
    channel,
    expectedPhoneE164: destination,
    expectedExternalUserId: destination,
    destinationAddress: destination,
  });

  // Compose SMS using the resend template
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

  // Update the new session's delivery tracking, carrying forward the cumulative send count
  updateSessionDelivery(newSession.sessionId, now, newSendCount, nextResendAt);

  // Send SMS
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
