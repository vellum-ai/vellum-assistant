import * as net from 'node:net';

import {
  createInvite,
  type InviteStatus,
  listInvites,
  redeemInvite,
  revokeInvite,
} from '../../memory/ingress-invite-store.js';
import {
  blockMember,
  type IngressMember,
  listMembers,
  revokeMember,
  upsertMember,
} from '../../memory/ingress-member-store.js';
import type { IngressInviteRequest, IngressMemberRequest } from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

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

export const inboxInviteHandlers = defineHandlers({
  ingress_invite: handleIngressInvite,
  ingress_member: handleIngressMember,
});
