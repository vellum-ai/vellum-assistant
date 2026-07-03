/**
 * Canonical guardian reply intercept stage: routes inbound messages from
 * guardian-class actors through the canonical decision pipeline before
 * they reach the legacy approval interception or the agent loop.
 *
 * Handles deterministic callbacks (button presses), request code prefixes,
 * and NL classification via the conversational approval engine.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId } from "../../../channels/types.js";
import {
  listCanonicalGuardianRequests,
  listPendingCanonicalGuardianRequestsByDestinationChat,
} from "../../../contacts/canonical-guardian-store.js";
import { getLogger } from "../../../util/logger.js";
import { deliverChannelReply } from "../../gateway-client.js";
import {
  type GuardianPendingScope,
  routeGuardianReply,
} from "../../guardian-reply-router.js";
import type { ApprovalConversationGenerator } from "../../http-types.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GuardianReplyInterceptParams {
  isDuplicate: boolean;
  trimmedContent: string;
  hasCallbackData: boolean;
  callbackData: string | undefined;
  /**
   * For emoji-reaction decisions: the channel-native id (Slack `ts`) of the
   * message the reaction was attached to. Threaded to the router so it can
   * recover the target request from the reacted card's delivery record.
   */
  reactedMessageTs?: string;
  rawSenderId: string | undefined;
  canonicalSenderId: string | null;
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  conversationId: string;
  eventId: string;
  replyCallbackUrl: string | undefined;
  trustClass: string;
  guardianPrincipalId: string | null | undefined;
  approvalConversationGenerator: ApprovalConversationGenerator | undefined;
}

export interface GuardianReplyInterceptResult {
  /** When true, the message was consumed and the pipeline should short-circuit with the response. */
  response: Record<string, unknown> | null;
  /** When true, legacy approval interception should be skipped for this message. */
  skipApprovalInterception: boolean;
}

/**
 * Route inbound guardian messages through the canonical decision pipeline.
 *
 * Returns a response if the message was consumed, or null to continue
 * the pipeline. Also signals whether legacy approval interception should
 * be bypassed.
 */
export async function handleGuardianReplyIntercept(
  params: GuardianReplyInterceptParams,
): Promise<GuardianReplyInterceptResult> {
  const {
    isDuplicate,
    trimmedContent,
    hasCallbackData,
    callbackData,
    reactedMessageTs,
    rawSenderId,
    canonicalSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    conversationId,
    eventId,
    replyCallbackUrl,
    trustClass,
    guardianPrincipalId,
    approvalConversationGenerator,
  } = params;

  const noAction: GuardianReplyInterceptResult = {
    response: null,
    skipApprovalInterception: false,
  };

  if (
    isDuplicate ||
    !replyCallbackUrl ||
    (trimmedContent.length === 0 && !hasCallbackData) ||
    !rawSenderId ||
    trustClass !== "guardian"
  ) {
    return noAction;
  }

  // Compute destination-scoped pending request hints so the router can
  // discover canonical requests delivered to this chat even when the
  // request lacks a guardianExternalUserId (e.g. voice-originated
  // pending_question requests).
  //
  // When delivery-scoped matches exist, union them with any identity-
  // based pending requests so that requests without delivery rows (e.g.
  // tool_approval requests created inline) are not silently excluded.
  //
  // On Slack, when no delivery-scoped results exist for the current chat,
  // use `{ mode: "blocked" }` rather than identity-fallback. This prevents
  // the router's identity-based fallback from intercepting unrelated
  // messages in other channels/threads — a cross-chat hijacking vector
  // unique to Slack where a single guardian is active in many threaded
  // contexts. Explicit callbacks (apr:<id>:<action>) and request codes
  // still work cross-chat because they carry specific request
  // identifiers and bypass the pending-request scope.
  //
  // Non-Slack channels (Telegram, WhatsApp) leave the scope unset so the
  // identity-based fallback stays active. On those channels, delivery
  // rows are created asynchronously (fire-and-forget .then()) so the
  // guardian can reply before the row is persisted. Cross-chat
  // contamination is unlikely there because each chat is a distinct
  // conversation with no thread concept.
  // Reactions address one specific request by the reacted card's message id,
  // so they bypass the pending-request list scoping that the text/NL paths
  // need — the router's reaction branch resolves the target directly.
  const isReaction = callbackData?.startsWith("reaction:") === true;
  let pendingScope: GuardianPendingScope | undefined;
  if (!isReaction) {
    const deliveryScopedPendingRequests =
      listPendingCanonicalGuardianRequestsByDestinationChat(
        sourceChannel,
        conversationExternalId,
      );
    if (deliveryScopedPendingRequests.length > 0) {
      const deliveryIds = new Set(
        deliveryScopedPendingRequests.map((r) => r.id),
      );
      // Also include identity-based pending requests so we don't hide them
      const identityId = canonicalSenderId ?? rawSenderId!;
      const identityPending = listCanonicalGuardianRequests({
        status: "pending",
        guardianExternalUserId: identityId,
      });
      for (const r of identityPending) {
        deliveryIds.add(r.id);
      }
      pendingScope = { mode: "scoped", requestIds: [...deliveryIds] };
    } else if (sourceChannel === "slack") {
      // Block identity-based fallback on Slack to prevent cross-chat
      // NL/free-text interception. See comment above for rationale.
      pendingScope = { mode: "blocked" };
    }
  }

  const routerResult = await routeGuardianReply({
    messageText: trimmedContent,
    channel: sourceChannel,
    actor: {
      actorPrincipalId: guardianPrincipalId ?? undefined,
      actorExternalUserId: canonicalSenderId ?? rawSenderId!,
      channel: sourceChannel,
      guardianPrincipalId: guardianPrincipalId ?? undefined,
    },
    conversationId,
    callbackData,
    reactedMessageTs,
    pendingScope,
    approvalConversationGenerator,
    channelDeliveryContext: {
      replyCallbackUrl,
      guardianChatId: conversationExternalId,
      assistantId: canonicalAssistantId,
    },
  });

  if (routerResult.consumed) {
    // Deliver reply text if the router produced one
    if (routerResult.replyText) {
      const routerReplyPayload: Parameters<typeof deliverChannelReply>[1] = {
        chatId: conversationExternalId,
        text: routerResult.replyText,
        assistantId: canonicalAssistantId,
      };
      // On Slack, send guardian management replies (disambiguation, pending
      // request lists, etc.) as ephemeral so only the guardian sees them.
      if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
        routerReplyPayload.ephemeral = true;
        routerReplyPayload.user = (canonicalSenderId ?? rawSenderId)!;
      }
      try {
        await deliverChannelReply(replyCallbackUrl, routerReplyPayload);
      } catch (err) {
        log.error(
          { err, conversationExternalId },
          "Failed to deliver canonical router reply",
        );
      }
    }

    return {
      response: {
        accepted: true,
        duplicate: false,
        eventId,
        canonicalRouter: routerResult.type,
        requestId: routerResult.requestId,
      },
      skipApprovalInterception: false,
    };
  }

  return {
    response: null,
    skipApprovalInterception: routerResult.skipApprovalInterception ?? false,
  };
}
