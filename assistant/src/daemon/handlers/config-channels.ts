import * as net from "node:net";

import type { ChannelId } from "../../channels/types.js";
import { resolveGuardianName } from "../../config/user-reference.js";
import {
  findContactChannel,
  findGuardianForChannel,
} from "../../contacts/contact-store.js";
import { revokeMember } from "../../contacts/contacts-write.js";
import type { ChannelStatus } from "../../contacts/types.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import {
  type ChannelReadinessService,
  createReadinessService,
} from "../../runtime/channel-readiness-service.js";
import {
  createVerificationChallenge,
  findActiveSession,
  getGuardianBinding,
  getPendingSession,
  revokeBinding,
  revokePendingSessions,
} from "../../runtime/channel-verification-service.js";
import {
  cancelOutbound,
  resendOutbound,
  startOutbound,
} from "../../runtime/verification-outbound-actions.js";
import type {
  ChannelVerificationSessionRequest,
  ChannelVerificationSessionResponse,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

// -- Transport-agnostic result type (omits the IPC `type` discriminant) --

export type ChannelVerificationSessionResult = Omit<
  ChannelVerificationSessionResponse,
  "type"
>;

// ---------------------------------------------------------------------------
// Re-export rate limit constants from the shared outbound actions module
// for backward compatibility with existing consumers.
// ---------------------------------------------------------------------------

export {
  DESTINATION_RATE_WINDOW_MS,
  MAX_SENDS_PER_DESTINATION_WINDOW,
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
} from "../../runtime/verification-outbound-actions.js";

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

export function createInboundChallenge(
  channel?: ChannelId,
  rebind?: boolean,
  sessionId?: string,
): ChannelVerificationSessionResult {
  const resolvedAssistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  const existingBinding = getGuardianBinding(
    resolvedAssistantId,
    resolvedChannel,
  );
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Revoke the existing binding first, or set rebind: true to replace.",
      channel: resolvedChannel,
    };
  }

  const result = createVerificationChallenge(resolvedChannel, sessionId);

  return {
    success: true,
    secret: result.secret,
    instruction: result.instruction,
    channel: resolvedChannel,
  };
}

export function getVerificationStatus(
  channel?: ChannelId,
): ChannelVerificationSessionResult {
  const resolvedAssistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  const binding = getGuardianBinding(resolvedAssistantId, resolvedChannel);

  // Read the contact directly to get displayName — getGuardianBinding is a
  // compatibility shim that doesn't carry metadataJson.
  const guardianResult = findGuardianForChannel(resolvedChannel);
  const bindingDisplayName = guardianResult?.contact.displayName;
  const guardianDisplayName = resolveGuardianName(bindingDisplayName);

  // Resolve username from external conversation store.
  let guardianUsername: string | undefined;
  if (binding?.guardianDeliveryChatId) {
    const ext = externalConversationStore.getBindingByChannelChat(
      resolvedChannel,
      binding.guardianDeliveryChatId,
    );
    if (ext?.username) {
      guardianUsername = ext.username;
    }
  }
  const hasPendingChallenge = getPendingSession(resolvedChannel) != null;

  // Include active outbound session state so the UI can resume
  // after app restart and detect bootstrap completion.
  const activeOutboundSession = findActiveSession(resolvedChannel);
  const outboundFields: Record<string, unknown> = {};
  if (activeOutboundSession) {
    outboundFields.verificationSessionId = activeOutboundSession.id;
    outboundFields.expiresAt = activeOutboundSession.expiresAt;
    outboundFields.nextResendAt = activeOutboundSession.nextResendAt;
    outboundFields.sendCount = activeOutboundSession.sendCount;
    if (activeOutboundSession.status === "pending_bootstrap") {
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
// Revoke verification binding
// ---------------------------------------------------------------------------

export function revokeVerificationForChannel(
  channel?: ChannelId,
): ChannelVerificationSessionResult {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  // Cancel any active outbound session so revoke is a complete teardown.
  cancelOutbound({ channel: resolvedChannel });

  // Always revoke pending challenges first — the macOS app uses
  // action: "revoke" to cancel an in-flight challenge even before
  // a binding exists (e.g. during verification setup).
  revokePendingSessions(resolvedChannel);

  // Capture binding before revoking so we can revoke the guardian's
  // contact record — without this, the guardian would still pass
  // the ACL check after unbinding.
  const bindingBeforeRevoke = getGuardianBinding(assistantId, resolvedChannel);
  if (!bindingBeforeRevoke) {
    return {
      success: true,
      bound: false,
      channel: resolvedChannel,
    };
  }

  // Revoke the member BEFORE the guardian binding so that
  // revokeMember sees the channel as active/pending and sets the
  // correct revokedReason ("guardian_binding_revoked"). If the guardian binding
  // is revoked first, the channel is already marked revoked and the member
  // revocation becomes a no-op (wrong reason or skipped entirely).
  const contactResult = findContactChannel({
    channelType: resolvedChannel,
    externalUserId: bindingBeforeRevoke.guardianExternalUserId,
    externalChatId: bindingBeforeRevoke.guardianDeliveryChatId,
  });

  if (contactResult) {
    const channelStatus: ChannelStatus = contactResult.channel.status;
    if (
      channelStatus === "active" ||
      channelStatus === "pending" ||
      channelStatus === "unverified"
    ) {
      revokeMember(contactResult.channel.id, "guardian_binding_revoked");
    }
  }

  revokeBinding(assistantId, resolvedChannel);

  return {
    success: true,
    bound: false,
    channel: resolvedChannel,
  };
}

// ---------------------------------------------------------------------------
// Channel verification session handler
// ---------------------------------------------------------------------------

export async function handleChannelVerificationSession(
  msg: ChannelVerificationSessionRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const channel = msg.channel ?? "telegram";

  try {
    if (msg.action === "create_session") {
      if (msg.destination) {
        const result = await startOutbound({
          channel,
          destination: msg.destination,
          rebind: msg.rebind,
          originConversationId: msg.originConversationId,
        });
        ctx.send(socket, {
          type: "channel_verification_session_response",
          ...result,
        });
      } else {
        const result = createInboundChallenge(
          channel,
          msg.rebind,
          msg.sessionId,
        );
        ctx.send(socket, {
          type: "channel_verification_session_response",
          ...result,
        });
      }
    } else if (msg.action === "status") {
      const result = getVerificationStatus(channel);
      ctx.send(socket, {
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "cancel_session") {
      cancelOutbound({ channel });
      revokePendingSessions(channel);
      ctx.send(socket, {
        type: "channel_verification_session_response",
        success: true,
        channel,
      });
    } else if (msg.action === "revoke") {
      const result = revokeVerificationForChannel(channel);
      ctx.send(socket, {
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "resend_session") {
      const result = resendOutbound({
        channel,
        originConversationId: msg.originConversationId,
      });
      ctx.send(socket, {
        type: "channel_verification_session_response",
        ...result,
      });
    } else {
      ctx.send(socket, {
        type: "channel_verification_session_response",
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
        channel,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle channel verification session");
    ctx.send(socket, {
      type: "channel_verification_session_response",
      success: false,
      error: message,
      channel,
    });
  }
}

export const channelHandlers = defineHandlers({
  channel_verification_session: handleChannelVerificationSession,
});
