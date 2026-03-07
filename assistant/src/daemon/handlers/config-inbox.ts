import * as net from "node:net";

import type { ChannelId } from "../../channels/types.js";
import { isChannelId, isInterfaceId } from "../../channels/types.js";
import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { addMessage, getMessages } from "../../memory/conversation-crud.js";
import { getLatestStoredPayload } from "../../memory/delivery-crud.js";
import { getBindingByConversation } from "../../memory/external-conversation-store.js";
import {
  type ApprovalRequestStatus,
  type GuardianApprovalRequest,
  listPendingApprovalRequests,
  resolveApprovalRequest,
} from "../../memory/guardian-approvals.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { mintDaemonDeliveryToken } from "../../runtime/auth/token-service.js";
import { deliverChannelReply } from "../../runtime/gateway-client.js";
import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  revokeIngressInvite,
} from "../../runtime/invite-service.js";
import type {
  AssistantInboxEscalationRequest,
  ContactsInviteRequest,
} from "../ipc-protocol.js";
import {
  defineHandlers,
  type HandlerContext,
  log,
  renderHistoryContent,
} from "./shared.js";

export async function handleContactsInvite(
  msg: ContactsInviteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    switch (msg.action) {
      case "create": {
        const result = await createIngressInvite({
          sourceChannel: msg.sourceChannel,
          note: msg.note,
          maxUses: msg.maxUses,
          expiresInMs: msg.expiresInMs,
          contactName: msg.contactName,
          friendName: msg.friendName,
          guardianName: msg.guardianName,
        });
        if (!result.ok) {
          ctx.send(socket, {
            type: "contacts_invite_response",
            success: false,
            error: result.error,
          });
          return;
        }
        ctx.send(socket, {
          type: "contacts_invite_response",
          success: true,
          invite: result.data,
        });
        return;
      }

      case "list": {
        const result = listIngressInvites({
          sourceChannel: msg.sourceChannel,
          status: msg.status,
        });
        if (!result.ok) {
          ctx.send(socket, {
            type: "contacts_invite_response",
            success: false,
            error: result.error,
          });
          return;
        }
        ctx.send(socket, {
          type: "contacts_invite_response",
          success: true,
          invites: result.data,
        });
        return;
      }

      case "revoke": {
        const result = revokeIngressInvite(msg.inviteId);
        if (!result.ok) {
          ctx.send(socket, {
            type: "contacts_invite_response",
            success: false,
            error: result.error,
          });
          return;
        }
        ctx.send(socket, {
          type: "contacts_invite_response",
          success: true,
          invite: result.data,
        });
        return;
      }

      case "redeem": {
        const result = redeemIngressInvite({
          token: msg.token,
          externalUserId: msg.externalUserId,
          externalChatId: msg.externalChatId,
          sourceChannel: msg.sourceChannel,
        });
        if (!result.ok) {
          ctx.send(socket, {
            type: "contacts_invite_response",
            success: false,
            error: result.error,
          });
          return;
        }
        ctx.send(socket, {
          type: "contacts_invite_response",
          success: true,
          invite: result.data,
        });
        return;
      }

      default: {
        ctx.send(socket, {
          type: "contacts_invite_response",
          success: false,
          error: `Unknown action: ${String(msg.action)}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "contacts_invite handler error");
    ctx.send(socket, {
      type: "contacts_invite_response",
      success: false,
      error: message,
    });
  }
}

export function handleInboxEscalation(
  msg: AssistantInboxEscalationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    switch (msg.action) {
      case "list": {
        const escalations = listPendingApprovalRequests({
          status: (msg.status as ApprovalRequestStatus) ?? undefined,
        });
        ctx.send(socket, {
          type: "assistant_inbox_escalation_response",
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

      case "decide": {
        if (!msg.approvalRequestId) {
          ctx.send(socket, {
            type: "assistant_inbox_escalation_response",
            success: false,
            error: "approvalRequestId is required for decide",
          });
          return;
        }
        if (!msg.decision) {
          ctx.send(socket, {
            type: "assistant_inbox_escalation_response",
            success: false,
            error: "decision is required for decide",
          });
          return;
        }

        const mappedDecision =
          msg.decision === "approve" ? "approved" : "denied";
        const resolved = resolveApprovalRequest(
          msg.approvalRequestId,
          mappedDecision,
        );

        if (!resolved) {
          ctx.send(socket, {
            type: "assistant_inbox_escalation_response",
            success: false,
            error: "Approval request not found or already resolved",
          });
          return;
        }

        // Respond immediately — decision execution happens in the background
        ctx.send(socket, {
          type: "assistant_inbox_escalation_response",
          success: true,
          decision: {
            id: resolved.id,
            status: resolved.status,
            decidedAt: resolved.updatedAt,
          },
        });

        // Fire-and-forget: execute the decision asynchronously
        executeEscalationDecision(
          resolved,
          msg.decision,
          msg.reason,
          ctx,
        ).catch((err) => {
          log.error(
            { err, approvalRequestId: resolved.id, decision: msg.decision },
            "Escalation decision execution failed",
          );
        });

        return;
      }

      default: {
        ctx.send(socket, {
          type: "assistant_inbox_escalation_response",
          success: false,
          error: `Unknown action: ${String(msg.action)}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "assistant_inbox_escalation handler error");
    ctx.send(socket, {
      type: "assistant_inbox_escalation_response",
      success: false,
      error: message,
    });
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
  decision: "approve" | "deny",
  reason: string | undefined,
  ctx: HandlerContext,
): Promise<void> {
  if (decision === "approve") {
    await executeApprove(approval, ctx);
  } else {
    await executeDeny(approval, reason);
  }
}

async function executeApprove(
  approval: GuardianApprovalRequest,
  ctx: HandlerContext,
): Promise<void> {
  const { conversationId, channel } = approval;

  // Recover the original message content from the stored payload
  const payload = getLatestStoredPayload(conversationId);
  const messageContent =
    typeof payload?.content === "string" ? payload.content : "";

  if (!messageContent) {
    log.warn(
      { conversationId, approvalId: approval.id },
      "No message content found for approved escalation; skipping processing",
    );
    return;
  }

  const sourceChannel: ChannelId | undefined = isChannelId(channel)
    ? channel
    : undefined;

  // Get or create a session for the conversation and process the message
  const session = await ctx.getOrCreateSession(conversationId);

  if (sourceChannel) {
    session.setTurnChannelContext({
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
    });
    const sourceInterface = isInterfaceId(sourceChannel)
      ? sourceChannel
      : undefined;
    if (sourceInterface) {
      session.setTurnInterfaceContext({
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
      });
    }
  }
  session.setAssistantId(DAEMON_INTERNAL_ASSISTANT_ID);
  // The guardian already approved this escalation via the inbox, so we
  // directly set guardian trust. Going through resolveLocalIpcTrustContext
  // would look up the vellum binding's guardian ID and compare it against
  // a different channel's binding (e.g. telegram/voice), misclassifying the
  // actor as 'unknown'.
  session.setTrustContext({
    sourceChannel: sourceChannel ?? "vellum",
    trustClass: "guardian",
  });
  session.setCommandIntent(null);

  // Process the message through the agent loop (no IPC event callback
  // since this is a background execution without a connected client)
  const noop = () => {};
  await session.processMessage(
    messageContent,
    [],
    noop,
    undefined,
    undefined,
    undefined,
    { isInteractive: false },
  );

  // Deliver the assistant's reply to the external user via the gateway
  const replyCallbackUrl =
    typeof payload?.replyCallbackUrl === "string"
      ? payload.replyCallbackUrl
      : null;
  const bearerToken = mintDaemonDeliveryToken();

  if (replyCallbackUrl) {
    const binding = getBindingByConversation(conversationId);
    const externalChatId = binding?.externalChatId ?? approval.requesterChatId;

    const msgs = getMessages(conversationId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(msgs[i].content);
        } catch {
          parsed = msgs[i].content;
        }
        const rendered = renderHistoryContent(parsed);
        if (rendered.text) {
          await deliverChannelReply(
            replyCallbackUrl,
            {
              chatId: externalChatId,
              text: rendered.text,
              assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
            },
            bearerToken,
          );
        }
        break;
      }
    }
  }

  log.info(
    { conversationId, approvalId: approval.id },
    "Approved escalation processed successfully",
  );
}

async function executeDeny(
  approval: GuardianApprovalRequest,
  reason: string | undefined,
): Promise<void> {
  const { conversationId, channel } = approval;

  const binding = getBindingByConversation(conversationId);
  if (!binding) {
    log.warn(
      { conversationId, approvalId: approval.id },
      "No external binding found for denied escalation; cannot send refusal",
    );
    return;
  }

  const sourceChannel: ChannelId | undefined = isChannelId(channel)
    ? channel
    : undefined;
  if (!sourceChannel) {
    log.warn(
      { conversationId, channel, approvalId: approval.id },
      "Invalid channel for denied escalation; cannot send refusal",
    );
    return;
  }

  const gatewayBaseUrl = getGatewayInternalBaseUrl();
  const deliverUrl = `${gatewayBaseUrl}/deliver/${sourceChannel}`;
  const bearerToken = mintDaemonDeliveryToken();

  const denialText = reason
    ? `Your message was reviewed and declined. Reason: ${reason}`
    : "Your message was reviewed and declined.";

  await deliverChannelReply(
    deliverUrl,
    {
      chatId: binding.externalChatId,
      text: denialText,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    },
    bearerToken,
  );

  // Store a system note about the denial in the conversation
  const denialInterface = isInterfaceId(sourceChannel)
    ? sourceChannel
    : undefined;
  await addMessage(conversationId, "assistant", denialText, {
    provenanceTrustClass: "guardian" as const,
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
    ...(denialInterface
      ? {
          userMessageInterface: denialInterface,
          assistantMessageInterface: denialInterface,
        }
      : {}),
  });

  log.info(
    { conversationId, approvalId: approval.id },
    "Denied escalation refusal sent",
  );
}

export const inboxInviteHandlers = defineHandlers({
  contacts_invite: handleContactsInvite,
  assistant_inbox_escalation: handleInboxEscalation,
});
