import * as net from 'node:net';

import type { ChannelId } from '../../channels/types.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import {
  createVerificationChallenge,
  findActiveSession,
  getGuardianBinding,
  getPendingChallenge,
  revokeBinding as revokeGuardianBinding,
  revokePendingChallenges,
} from '../../runtime/channel-guardian-service.js';
import { type ChannelReadinessService, createReadinessService } from '../../runtime/channel-readiness-service.js';
import {
  cancelOutbound,
  resendOutbound,
  startOutbound,
} from '../../runtime/guardian-outbound-actions.js';
import { normalizeAssistantId } from '../../util/platform.js';
import type {
  ChannelReadinessRequest,
  GuardianVerificationRequest,
  GuardianVerificationResponse,
} from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

// -- Transport-agnostic result type (omits the IPC `type` discriminant) --

export type GuardianVerificationResult = Omit<GuardianVerificationResponse, 'type'>;

// ---------------------------------------------------------------------------
// Re-export rate limit constants from the shared outbound actions module
// for backward compatibility with existing consumers.
// ---------------------------------------------------------------------------

export {
  DESTINATION_RATE_WINDOW_MS,
  MAX_SENDS_PER_DESTINATION_WINDOW,
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
} from '../../runtime/guardian-outbound-actions.js';

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
// Extracted business logic functions
// ---------------------------------------------------------------------------

export function createGuardianChallenge(
  channel?: ChannelId,
  assistantId?: string,
  rebind?: boolean,
  sessionId?: string,
): GuardianVerificationResult {
  const resolvedAssistantId = normalizeAssistantId(assistantId ?? 'self');
  const resolvedChannel = channel ?? 'telegram';

  const existingBinding = getGuardianBinding(resolvedAssistantId, resolvedChannel);
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: 'already_bound',
      message: 'A guardian is already bound for this channel. Revoke the existing binding first, or set rebind: true to replace.',
      channel: resolvedChannel,
    };
  }

  const result = createVerificationChallenge(resolvedAssistantId, resolvedChannel, sessionId);

  return {
    success: true,
    secret: result.secret,
    instruction: result.instruction,
    channel: resolvedChannel,
  };
}

export function getGuardianStatus(
  channel?: ChannelId,
  assistantId?: string,
): GuardianVerificationResult {
  const resolvedAssistantId = normalizeAssistantId(assistantId ?? 'self');
  const resolvedChannel = channel ?? 'telegram';

  const binding = getGuardianBinding(resolvedAssistantId, resolvedChannel);
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
      resolvedChannel,
      binding.guardianDeliveryChatId,
    );
    if (!guardianUsername && ext?.username) {
      guardianUsername = ext.username;
    }
    if (!guardianDisplayName && ext?.displayName) {
      guardianDisplayName = ext.displayName;
    }
  }
  const hasPendingChallenge = getPendingChallenge(resolvedAssistantId, resolvedChannel) != null;

  // Include active outbound session state so the UI can resume
  // after app restart and detect bootstrap completion.
  const activeOutboundSession = findActiveSession(resolvedAssistantId, resolvedChannel);
  const outboundFields: Record<string, unknown> = {};
  if (activeOutboundSession) {
    outboundFields.verificationSessionId = activeOutboundSession.id;
    outboundFields.expiresAt = activeOutboundSession.expiresAt;
    outboundFields.nextResendAt = activeOutboundSession.nextResendAt;
    outboundFields.sendCount = activeOutboundSession.sendCount;
    if (activeOutboundSession.status === 'pending_bootstrap') {
      outboundFields.pendingBootstrap = true;
    }
  }

  return {
    success: true,
    bound: binding != null,
    guardianExternalUserId: binding?.guardianExternalUserId,
    guardianUsername,
    guardianDisplayName,
    channel: resolvedChannel,
    assistantId: resolvedAssistantId,
    guardianDeliveryChatId: binding?.guardianDeliveryChatId,
    hasPendingChallenge,
    ...outboundFields,
  };
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
      const result = createGuardianChallenge(channel, assistantId, msg.rebind, msg.sessionId);
      ctx.send(socket, { type: 'guardian_verification_response', ...result });
    } else if (msg.action === 'status') {
      const result = getGuardianStatus(channel, assistantId);
      ctx.send(socket, { type: 'guardian_verification_response', ...result });
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
      const result = startOutbound({ channel, assistantId, destination: msg.destination, rebind: msg.rebind, originConversationId: msg.originConversationId });
      ctx.send(socket, { type: 'guardian_verification_response', ...result });
    } else if (msg.action === 'resend_outbound') {
      const result = resendOutbound({ channel, assistantId, originConversationId: msg.originConversationId });
      ctx.send(socket, { type: 'guardian_verification_response', ...result });
    } else if (msg.action === 'cancel_outbound') {
      const result = cancelOutbound({ channel, assistantId });
      ctx.send(socket, { type: 'guardian_verification_response', ...result });
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
