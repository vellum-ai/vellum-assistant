import * as net from 'node:net';
import type { IngressInviteRequest, IngressMemberRequest, AssistantInboxEscalationRequest, AssistantInboxReplyRequest } from '../ipc-protocol.js';
import type { ChannelId } from '../../channels/types.js';
import { isChannelId } from '../../channels/types.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';
import {
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
  type InviteStatus,
} from '../../memory/ingress-invite-store.js';
import {
  upsertMember,
  listMembers,
  revokeMember,
  blockMember,
  type IngressMember,
} from '../../memory/ingress-member-store.js';
import {
  listPendingApprovalRequests,
  resolveApprovalRequest,
  type ApprovalRequestStatus,
} from '../../memory/channel-guardian-store.js';
import { refreshThreadEscalation } from '../../memory/inbox-escalation-projection.js';
import { addMessage, getMessages } from '../../memory/conversation-store.js';
import { getBindingByConversation } from '../../memory/external-conversation-store.js';
import { updateThreadActivity } from '../../memory/inbox-thread-store.js';
import { getLatestStoredPayload } from '../../memory/channel-delivery-store.js';
import { deliverChannelReply } from '../../runtime/gateway-client.js';
import { getGatewayInternalBaseUrl, getRuntimeProxyBearerToken } from '../../config/env.js';
import { renderHistoryContent } from './shared.js';
import type { GuardianApprovalRequest } from '../../memory/channel-guardian-store.js';

export function handleIngressInvite(
  msg: IngressInviteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    switch (msg.action) {
      case 'create': {
        if (!msg.sourceChannel) {
          ctx.send(socket, { type: 'ingress_invite_response', success: false, error: 'sourceChannel is required for create' });
          return;
        }
        const { invite, rawToken } = createInvite({
          sourceChannel: msg.sourceChannel,
          note: msg.note,
          maxUses: msg.maxUses,
          expiresInMs: msg.expiresInMs,
        });
        ctx.send(socket, {
          type: 'ingress_invite_response',
          success: true,
          invite: {
            id: invite.id,
            sourceChannel: invite.sourceChannel,
            token: rawToken,
            tokenHash: invite.tokenHash,
            maxUses: invite.maxUses,
            useCount: invite.useCount,
            expiresAt: invite.expiresAt,
            status: invite.status,
            note: invite.note ?? undefined,
            createdAt: invite.createdAt,
          },
        });
        return;
      }

      case 'list': {
        const invites = listInvites({
          sourceChannel: msg.sourceChannel,
          status: msg.status as InviteStatus | undefined,
        });
        ctx.send(socket, {
          type: 'ingress_invite_response',
          success: true,
          invites: invites.map((inv) => ({
            id: inv.id,
            sourceChannel: inv.sourceChannel,
            tokenHash: inv.tokenHash,
            maxUses: inv.maxUses,
            useCount: inv.useCount,
            expiresAt: inv.expiresAt,
            status: inv.status,
            note: inv.note ?? undefined,
            createdAt: inv.createdAt,
          })),
        });
        return;
      }

      case 'revoke': {
        if (!msg.inviteId) {
          ctx.send(socket, { type: 'ingress_invite_response', success: false, error: 'inviteId is required for revoke' });
          return;
        }
        const revoked = revokeInvite(msg.inviteId);
        if (!revoked) {
          ctx.send(socket, { type: 'ingress_invite_response', success: false, error: 'Invite not found or already revoked' });
          return;
        }
        ctx.send(socket, {
          type: 'ingress_invite_response',
          success: true,
          invite: {
            id: revoked.id,
            sourceChannel: revoked.sourceChannel,
            tokenHash: revoked.tokenHash,
            maxUses: revoked.maxUses,
            useCount: revoked.useCount,
            expiresAt: revoked.expiresAt,
            status: revoked.status,
            note: revoked.note ?? undefined,
            createdAt: revoked.createdAt,
          },
        });
        return;
      }

      case 'redeem': {
        if (!msg.token) {
          ctx.send(socket, { type: 'ingress_invite_response', success: false, error: 'token is required for redeem' });
          return;
        }
        const result = redeemInvite({
          rawToken: msg.token,
          externalUserId: msg.externalUserId,
          externalChatId: msg.externalChatId,
          sourceChannel: msg.sourceChannel,
        });
        if ('error' in result) {
          ctx.send(socket, { type: 'ingress_invite_response', success: false, error: result.error });
          return;
        }
        ctx.send(socket, {
          type: 'ingress_invite_response',
          success: true,
          invite: {
            id: result.invite.id,
            sourceChannel: result.invite.sourceChannel,
            tokenHash: result.invite.tokenHash,
            maxUses: result.invite.maxUses,
            useCount: result.invite.useCount,
            expiresAt: result.invite.expiresAt,
            status: result.invite.status,
            note: result.invite.note ?? undefined,
            createdAt: result.invite.createdAt,
          },
        });
        return;
      }

      default: {
        ctx.send(socket, { type: 'ingress_invite_response', success: false, error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'ingress_invite handler error');
    ctx.send(socket, { type: 'ingress_invite_response', success: false, error: message });
  }
}

function memberToResponse(m: IngressMember) {
  return {
    id: m.id,
    sourceChannel: m.sourceChannel,
    externalUserId: m.externalUserId ?? undefined,
    externalChatId: m.externalChatId ?? undefined,
    displayName: m.displayName ?? undefined,
    username: m.username ?? undefined,
    status: m.status,
    policy: m.policy,
    lastSeenAt: m.lastSeenAt ?? undefined,
    createdAt: m.createdAt,
  };
}

export function handleIngressMember(
  msg: IngressMemberRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    switch (msg.action) {
      case 'list': {
        const members = listMembers({
          assistantId: msg.assistantId,
          sourceChannel: msg.sourceChannel,
          status: msg.status,
          policy: msg.policy,
        });
        ctx.send(socket, {
          type: 'ingress_member_response',
          success: true,
          members: members.map(memberToResponse),
        });
        return;
      }

      case 'upsert': {
        if (!msg.sourceChannel) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'sourceChannel is required for upsert' });
          return;
        }
        if (!msg.externalUserId && !msg.externalChatId) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'At least one of externalUserId or externalChatId is required for upsert' });
          return;
        }
        const member = upsertMember({
          assistantId: msg.assistantId,
          sourceChannel: msg.sourceChannel,
          externalUserId: msg.externalUserId,
          externalChatId: msg.externalChatId,
          displayName: msg.displayName,
          username: msg.username,
          policy: msg.policy,
          status: msg.status,
        });
        ctx.send(socket, {
          type: 'ingress_member_response',
          success: true,
          member: memberToResponse(member),
        });
        return;
      }

      case 'revoke': {
        if (!msg.memberId) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'memberId is required for revoke' });
          return;
        }
        const revoked = revokeMember(msg.memberId, msg.reason);
        if (!revoked) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'Member not found or cannot be revoked' });
          return;
        }
        ctx.send(socket, {
          type: 'ingress_member_response',
          success: true,
          member: memberToResponse(revoked),
        });
        return;
      }

      case 'block': {
        if (!msg.memberId) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'memberId is required for block' });
          return;
        }
        const blocked = blockMember(msg.memberId, msg.reason);
        if (!blocked) {
          ctx.send(socket, { type: 'ingress_member_response', success: false, error: 'Member not found or already blocked' });
          return;
        }
        ctx.send(socket, {
          type: 'ingress_member_response',
          success: true,
          member: memberToResponse(blocked),
        });
        return;
      }

      default: {
        ctx.send(socket, { type: 'ingress_member_response', success: false, error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'ingress_member handler error');
    ctx.send(socket, { type: 'ingress_member_response', success: false, error: message });
  }
}

export function handleInboxEscalation(
  msg: AssistantInboxEscalationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    switch (msg.action) {
      case 'list': {
        const escalations = listPendingApprovalRequests({
          assistantId: msg.assistantId,
          status: (msg.status as ApprovalRequestStatus) ?? undefined,
        });
        ctx.send(socket, {
          type: 'assistant_inbox_escalation_response',
          success: true,
          escalations: escalations.map((req) => ({
            id: req.id,
            runId: req.runId,
            conversationId: req.conversationId,
            channel: req.channel,
            requesterExternalUserId: req.requesterExternalUserId,
            requesterChatId: req.requesterChatId,
            status: req.status,
            requestSummary: req.reason ?? undefined,
            createdAt: req.createdAt,
          })),
        });
        return;
      }

      case 'decide': {
        if (!msg.approvalRequestId) {
          ctx.send(socket, { type: 'assistant_inbox_escalation_response', success: false, error: 'approvalRequestId is required for decide' });
          return;
        }
        if (!msg.decision) {
          ctx.send(socket, { type: 'assistant_inbox_escalation_response', success: false, error: 'decision is required for decide' });
          return;
        }

        const mappedDecision = msg.decision === 'approve' ? 'approved' : 'denied';
        const resolved = resolveApprovalRequest(msg.approvalRequestId, mappedDecision);

        if (!resolved) {
          ctx.send(socket, { type: 'assistant_inbox_escalation_response', success: false, error: 'Approval request not found or already resolved' });
          return;
        }

        // Update thread escalation state so inbox badges stay accurate
        refreshThreadEscalation(resolved.conversationId, resolved.assistantId);

        // Respond immediately — decision execution happens in the background
        ctx.send(socket, {
          type: 'assistant_inbox_escalation_response',
          success: true,
          decision: {
            id: resolved.id,
            status: resolved.status,
            decidedAt: resolved.updatedAt,
          },
        });

        // Fire-and-forget: execute the decision asynchronously
        executeEscalationDecision(resolved, msg.decision, msg.reason, ctx).catch((err) => {
          log.error({ err, approvalRequestId: resolved.id, decision: msg.decision }, 'Escalation decision execution failed');
        });

        return;
      }

      default: {
        ctx.send(socket, { type: 'assistant_inbox_escalation_response', success: false, error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'assistant_inbox_escalation handler error');
    ctx.send(socket, { type: 'assistant_inbox_escalation_response', success: false, error: message });
  }
}

/**
 * Execute the post-decision logic for an ingress escalation.
 *
 * On approve: process the blocked inbound message through the session
 * pipeline and deliver the assistant's reply via the gateway.
 *
 * On deny: send a refusal message to the sender via the channel.
 */
async function executeEscalationDecision(
  approval: GuardianApprovalRequest,
  decision: 'approve' | 'deny',
  reason: string | undefined,
  ctx: HandlerContext,
): Promise<void> {
  if (decision === 'approve') {
    await executeApprove(approval, ctx);
  } else {
    await executeDeny(approval, reason);
  }
}

async function executeApprove(
  approval: GuardianApprovalRequest,
  ctx: HandlerContext,
): Promise<void> {
  const { conversationId, assistantId, channel } = approval;

  // Recover the original message content from the stored payload
  const payload = getLatestStoredPayload(conversationId);
  const messageContent = typeof payload?.content === 'string' ? payload.content : '';

  if (!messageContent) {
    log.warn({ conversationId, approvalId: approval.id }, 'No message content found for approved escalation; skipping processing');
    return;
  }

  const sourceChannel: ChannelId | undefined = isChannelId(channel) ? channel : undefined;

  // Get or create a session for the conversation and process the message
  const session = await ctx.getOrCreateSession(conversationId);

  if (sourceChannel) {
    session.setTurnChannelContext({
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
    });
  }
  session.setAssistantId(assistantId);
  // Daemon inbox handler — the guardian approved this escalation, so tag as
  // guardian to avoid 'unverified_channel' blocking memory extraction.
  session.setGuardianContext({ actorRole: 'guardian', sourceChannel: sourceChannel ?? 'vellum' });
  session.setCommandIntent(null);

  // Process the message through the agent loop (no IPC event callback
  // since this is a background execution without a connected client)
  const noop = () => {};
  await session.processMessage(messageContent, [], noop);

  // Deliver the assistant's reply to the external user via the gateway
  const replyCallbackUrl = typeof payload?.replyCallbackUrl === 'string'
    ? payload.replyCallbackUrl
    : null;
  const bearerToken = getRuntimeProxyBearerToken();

  if (replyCallbackUrl) {
    const binding = getBindingByConversation(conversationId);
    const externalChatId = binding?.externalChatId ?? approval.requesterChatId;

    const msgs = getMessages(conversationId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        let parsed: unknown;
        try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
        const rendered = renderHistoryContent(parsed);
        if (rendered.text) {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: rendered.text,
            assistantId,
          }, bearerToken);
        }
        break;
      }
    }
  }

  // Update thread activity to reflect the outbound reply
  updateThreadActivity(conversationId, 'outbound');

  log.info({ conversationId, approvalId: approval.id }, 'Approved escalation processed successfully');
}

async function executeDeny(
  approval: GuardianApprovalRequest,
  reason: string | undefined,
): Promise<void> {
  const { conversationId, assistantId, channel } = approval;

  const binding = getBindingByConversation(conversationId);
  if (!binding) {
    log.warn({ conversationId, approvalId: approval.id }, 'No external binding found for denied escalation; cannot send refusal');
    return;
  }

  const sourceChannel: ChannelId | undefined = isChannelId(channel) ? channel : undefined;
  if (!sourceChannel) {
    log.warn({ conversationId, channel, approvalId: approval.id }, 'Invalid channel for denied escalation; cannot send refusal');
    return;
  }

  const gatewayBaseUrl = getGatewayInternalBaseUrl();
  const deliverUrl = `${gatewayBaseUrl}/deliver/${sourceChannel}`;
  const bearerToken = getRuntimeProxyBearerToken();

  const denialText = reason
    ? `Your message was reviewed and declined. Reason: ${reason}`
    : 'Your message was reviewed and declined.';

  await deliverChannelReply(deliverUrl, {
    chatId: binding.externalChatId,
    text: denialText,
    assistantId,
  }, bearerToken);

  // Store a system note about the denial in the conversation
  addMessage(conversationId, 'assistant', denialText, {
    provenanceActorRole: 'guardian' as const,
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
  });
  updateThreadActivity(conversationId, 'outbound');

  log.info({ conversationId, approvalId: approval.id }, 'Denied escalation refusal sent');
}

export function handleAssistantInboxReply(
  msg: AssistantInboxReplyRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const { conversationId, content } = msg;

    if (!conversationId || !content) {
      ctx.send(socket, { type: 'assistant_inbox_reply_response', success: false, error: 'conversationId and content are required' });
      return;
    }

    // Verify the conversation has an external binding
    const binding = getBindingByConversation(conversationId);
    if (!binding) {
      ctx.send(socket, { type: 'assistant_inbox_reply_response', success: false, error: 'No external binding found for conversation' });
      return;
    }

    // Store the reply as an assistant message
    const bindingChannel = isChannelId(binding.sourceChannel) ? binding.sourceChannel : null;
    const message = addMessage(
      conversationId,
      'assistant',
      content,
      {
        provenanceActorRole: 'guardian' as const,
        ...(bindingChannel
          ? { userMessageChannel: bindingChannel, assistantMessageChannel: bindingChannel }
          : {}),
      },
    );

    // Update thread activity timestamps (resets unread count, updates last_outbound_at)
    updateThreadActivity(conversationId, 'outbound');

    ctx.send(socket, {
      type: 'assistant_inbox_reply_response',
      success: true,
      messageId: message.id,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'assistant_inbox_reply handler error');
    ctx.send(socket, { type: 'assistant_inbox_reply_response', success: false, error: errorMessage });
  }
}

export const inboxInviteHandlers = defineHandlers({
  ingress_invite: handleIngressInvite,
  ingress_member: handleIngressMember,
  assistant_inbox_escalation: handleInboxEscalation,
  assistant_inbox_reply: handleAssistantInboxReply,
});
