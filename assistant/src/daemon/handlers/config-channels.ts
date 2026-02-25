import * as net from 'node:net';
import { createVerificationChallenge, getGuardianBinding, getPendingChallenge, revokeBinding as revokeGuardianBinding, revokePendingChallenges } from '../../runtime/channel-guardian-service.js';
import { createReadinessService, type ChannelReadinessService } from '../../runtime/channel-readiness-service.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import type {
  GuardianVerificationRequest,
  ChannelReadinessRequest,
} from '../ipc-protocol.js';
import { normalizeAssistantId } from '../../util/platform.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

// Lazy singleton — created on first use so module-load stays lightweight.
let _readinessService: ChannelReadinessService | undefined;
export function getReadinessService(): ChannelReadinessService {
  if (!_readinessService) {
    _readinessService = createReadinessService();
  }
  return _readinessService;
}

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
        } as any);
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
