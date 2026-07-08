/**
 * Route handlers for conversation messages and suggestions.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  CLIENT_METADATA_HEADERS,
  type ClientMetadataField,
  sanitizeClientMetadataValue,
} from "@vellumai/service-contracts/client-metadata";
import { z } from "zod";

import { enrichMessageWithSourcePaths } from "../../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../../agent/message-types.js";
import {
  BackgroundToolCompletionSchema,
  type ConversationContentBlock,
  type ConversationMessage,
  ConversationMessageSchema,
} from "../../api/responses/conversation-message.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isInteractiveInterface,
  parseChannelId,
  parseClientOs,
  parseInterfaceId,
  supportsHostProxy,
} from "../../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getEffectiveProfiles } from "../../config/default-profile-catalog.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import { getConfig } from "../../config/loader.js";
import {
  listCanonicalGuardianRequests,
  listPendingRequestsByConversationScope,
  resolveCanonicalGuardianRequest,
} from "../../contacts/canonical-guardian-store.js";
import {
  mergeConsecutiveAssistantMessages,
  mergeToolResultsIntoAssistantMessages,
} from "../../conversations/message-consolidation.js";
import { createApprovalConversationGenerator } from "../../daemon/approval-generators.js";
import type { Conversation } from "../../daemon/conversation.js";
import { persistQueuedMessageBody } from "../../daemon/conversation-messaging.js";
import {
  buildModelInfoEvent,
  formatCleanResult,
  formatCompactResult,
  isModelSlashCommand,
} from "../../daemon/conversation-process.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import {
  buildSlashContextForContent,
  resolveSlash,
} from "../../daemon/conversation-slash.js";
import { getOrCreateConversation as getOrCreateConversationInstance } from "../../daemon/conversation-store.js";
import { canonicalizeTimeZone } from "../../daemon/date-context.js";
import {
  buildScanFirstMessage,
  buildSelfIntroMessage,
  getCannedFirstGreeting,
  isWakeUpGreeting,
} from "../../daemon/first-greeting.js";
import { supersedePendingInteractionsOnEnqueue } from "../../daemon/handlers/conversations.js";
import {
  collectAttachmentRefs,
  type HistoryAttachmentRef,
  renderHistoryContent,
} from "../../daemon/handlers/shared.js";
import { HostAppControlProxy } from "../../daemon/host-app-control-proxy.js";
import { HostCuProxy } from "../../daemon/host-cu-proxy.js";
import {
  preactivateHostProxySkills,
  shouldAttachHostProxyForCapability,
} from "../../daemon/host-proxy-preactivation.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type {
  HostProxyTransportMetadata,
  NonHostProxyTransportMetadata,
} from "../../daemon/message-types/conversations.js";
import type { TrustContext } from "../../daemon/trust-context-types.js";
import { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import {
  writeOnboardingSidecar,
  writeRelationshipState,
} from "../../home/relationship-state-writer.js";
import { ipcCall } from "../../ipc/gateway-client.js";
import { buildSlackMessageDeepLinks } from "../../messaging/providers/slack/deep-link.js";
import {
  readSlackMetadataFromMessageMetadata,
  type SlackMessageMetadata,
} from "../../messaging/providers/slack/message-metadata.js";
import { recordOnboardingEvent } from "../../onboarding/onboarding-events-store.js";
import {
  classifyKind,
  getAttachmentById,
  getAttachmentMetadataForMessage,
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../../persistence/attachments-store.js";
import {
  addMessage,
  extractImageSourcePaths,
  getConversation,
  getConversationPersistedSeq,
  getMessages,
  getMessagesPaginated,
  hasMessages,
  isConversationProcessing,
  isHiddenMessageMetadata,
  type MessageRow,
  provenanceFromTrustContext,
  recordConversationPersistedSeq,
  setConversationInferenceProfile,
} from "../../persistence/conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
} from "../../persistence/conversation-key-store.js";
import { searchConversations } from "../../persistence/conversation-queries.js";
import { MEMORY_RETROSPECTIVE_FORK_SOURCE } from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import { normalizeOnboardingContext } from "../../prompts/normalize-onboarding.js";
import { writeOnboardingSection } from "../../prompts/persona-resolver.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { getSubagentManager } from "../../subagent/index.js";
import {
  isHeicFilename,
  normalizeImageBase64,
} from "../../util/image-conversion.js";
import { getLogger } from "../../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";
import { silentlyWithLog } from "../../util/silently.js";
import { assistantEventHub, broadcastMessage } from "../assistant-event-hub.js";
import { getCurrentSeq } from "../assistant-stream-state.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  type GuardianPendingScope,
  routeGuardianReply,
} from "../guardian-reply-router.js";
import { reResolveTrustOnResetDrift } from "../guardian-vellum-migration.js";
import type {
  ApprovalConversationGenerator,
  RuntimeAttachmentMetadata,
  RuntimeMessagePayload,
  SendMessageDeps,
} from "../http-types.js";
import {
  findLocalGuardianPrincipalId,
  resolveActorPrincipalIdForLocalGuardian,
} from "../local-actor-identity.js";
import { resolveLocalPrincipalTrustContext } from "../local-principal-trust.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  publishConversationListAndMetadataChanged,
  publishConversationMessagesChanged,
} from "../sync/resource-sync-events.js";
import { withSourceChannel } from "../trust-context-resolver.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  RouteError,
} from "./errors.js";
import {
  collectPendingConfirmations,
  enrichToolCallsWithConfirmation,
} from "./tool-call-confirmation-enrichment.js";
import {
  collectPendingQuestions,
  enrichToolCallsWithQuestion,
} from "./tool-call-question-enrichment.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";

const log = getLogger("conversation-routes");

/** Matches the `<no_response/>` sentinel used by channel delivery suppression. */
const NO_RESPONSE_INLINE_RE = /<no_response\s*\/?>/g;
const ATTACHMENT_ENTRY_RE = /^attachment:(\d+)$/;

/** Rewrites a rendered `contentOrder` to reflect attachment alignment. */
type ContentOrderRewrite = (contentOrder: string[]) => string[];

interface AlignedAttachments {
  /** Hydrated rows, reordered to match the inline file-block order. */
  attachments: RuntimeAttachmentMetadata[];
  /**
   * Resolves a content-walk attachment ref index to its hydrated DB row,
   * mirroring the inline placement `rewriteContentOrder` encodes. Refs with no
   * inline placement (unmatched ids, count mismatch, no DB rows) are absent, so
   * `renderHistoryContent` emits no `attachment` block for them — the row still
   * ships via the flat `attachments` array.
   */
  refIndexToAttachment: Map<number, RuntimeAttachmentMetadata>;
  rewriteContentOrder: ContentOrderRewrite;
}

/**
 * Align DB-hydrated attachment rows with the file-block refs `renderHistoryContent`
 * captured. When a file block carries an attachment id (user-message uploads —
 * on `source.attachmentId` for reference blocks, or the legacy top-level
 * `_attachmentId`) we join on that id to position the chip inline; DB rows
 * without a matching ref go to the tail as orphan chips, and unmatched refs drop
 * their `attachment:N` entry. Assistant-authored file blocks carry no id, so
 * when no ids match we fall back to positional alignment if the ref and row
 * counts agree; otherwise we strip the markers and let chips fall to the tail.
 */
function alignAttachments(
  attachmentRefs: HistoryAttachmentRef[],
  attachments: RuntimeAttachmentMetadata[],
): AlignedAttachments {
  const refIndexToAttachment = new Map<number, RuntimeAttachmentMetadata>();
  const identity: ContentOrderRewrite = (contentOrder) => contentOrder;
  const stripAttachmentEntries: ContentOrderRewrite = (contentOrder) =>
    contentOrder.filter((entry) => !ATTACHMENT_ENTRY_RE.test(entry));

  if (attachmentRefs.length === 0) {
    return { attachments, refIndexToAttachment, rewriteContentOrder: identity };
  }
  if (attachments.length === 0) {
    // Refs were captured but no DB rows came back — drop the contentOrder
    // entries to avoid out-of-bounds renders.
    return {
      attachments,
      refIndexToAttachment,
      rewriteContentOrder: stripAttachmentEntries,
    };
  }

  const byId = new Map<string, number>();
  attachments.forEach((att, idx) => {
    if (att.id) byId.set(att.id, idx);
  });
  const consumed = new Set<number>();
  const orderedRowIdx: Array<number | null> = attachmentRefs.map((ref) => {
    if (!ref.attachmentId) return null;
    const idx = byId.get(ref.attachmentId);
    if (idx === undefined || consumed.has(idx)) return null;
    consumed.add(idx);
    return idx;
  });
  const matchedRows = orderedRowIdx.filter(
    (idx): idx is number => idx !== null,
  );

  if (matchedRows.length > 0) {
    const orphanRows: number[] = [];
    for (let i = 0; i < attachments.length; i++) {
      if (!consumed.has(i)) orphanRows.push(i);
    }
    const reordered = [
      ...matchedRows.map((i) => attachments[i]),
      ...orphanRows.map((i) => attachments[i]),
    ];
    const refToNewIdx = new Map<number, number>();
    let nextIdx = 0;
    orderedRowIdx.forEach((rowIdx, refIdx) => {
      if (rowIdx !== null) {
        refToNewIdx.set(refIdx, nextIdx);
        refIndexToAttachment.set(refIdx, reordered[nextIdx]);
        nextIdx++;
      }
    });
    const rewriteContentOrder: ContentOrderRewrite = (contentOrder) =>
      contentOrder
        .map((entry) => {
          const match = entry.match(ATTACHMENT_ENTRY_RE);
          if (!match) return entry;
          const remapped = refToNewIdx.get(Number(match[1]));
          return remapped !== undefined ? `attachment:${remapped}` : undefined;
        })
        .filter((e): e is string => e !== undefined);
    return {
      attachments: reordered,
      refIndexToAttachment,
      rewriteContentOrder,
    };
  }

  if (attachmentRefs.length !== attachments.length) {
    // No ref carried an attachmentId we could match and the counts disagree, so
    // positional mapping can't be trusted — strip any attachment:N entries so
    // the client doesn't position attachments inline against a misaligned array
    // (they fall to the tail instead).
    return {
      attachments,
      refIndexToAttachment,
      rewriteContentOrder: stripAttachmentEntries,
    };
  }

  // No ref matched an id but the counts agree (the assistant-authored case):
  // the Nth marker maps to the Nth row positionally, so the original
  // contentOrder is left untouched.
  attachmentRefs.forEach((_ref, refIdx) => {
    refIndexToAttachment.set(refIdx, attachments[refIdx]);
  });
  return { attachments, refIndexToAttachment, rewriteContentOrder: identity };
}

/** Feature flag gating the self-intro first message (see first-greeting.ts). */
const SELF_INTRO_GREETING_FLAG = "self-intro-greeting" as const;

const SUGGESTION_CACHE_MAX = 100;
const VALID_RISK_THRESHOLDS = ["none", "low", "medium", "high"] as const;
type RiskThreshold = (typeof VALID_RISK_THRESHOLDS)[number];

function isValidRiskThreshold(value: unknown): value is RiskThreshold {
  return (
    typeof value === "string" &&
    VALID_RISK_THRESHOLDS.includes(value as RiskThreshold)
  );
}

// ---------------------------------------------------------------------------
// Temporary fix — remove when #31994 lands
// ---------------------------------------------------------------------------
//
// The canned-response paths in this file (canned greeting, inline approval
// reply, slash command, /compact, /clean) bypass the agent loop and so don't
// pick up the per-turn anchor id allocated in conversation-agent-loop.ts.
// Their `message_complete` events therefore went out without `messageId`,
// and the macOS client filter at ChatActionHandler.swift:507 dropped those
// events when they raced past the 50 ms streaming-buffer flush — leaving
// `isSending` stuck for the full 60 s watchdog window.
//
// Centralized so the patch surface is one helper + N one-line callers rather
// than N duplicated literals. When #31994 lands and stamps these sites with
// `state.assistantTurnId` directly, grep for `emitCannedMessageComplete` to
// find every call site and inline-then-delete.
function emitCannedMessageComplete(
  send: (msg: ServerMessage) => void,
  conversationId: string,
  persistedAssistantId: string,
): void {
  send({
    type: "message_complete",
    conversationId,
    messageId: persistedAssistantId,
  });
}

/**
 * True when a message's persisted metadata explicitly flags it as hidden.
 * Used to suppress internal scaffolding messages from UI history while
 * leaving them in the LLM-side context.
 */
function isHiddenMessage(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    return isHiddenMessageMetadata(
      JSON.parse(metadata) as Record<string, unknown>,
    );
  } catch {
    return false;
  }
}

function buildSlackHistoryMessage(
  slackMeta: SlackMessageMetadata | null,
  opts?: { role?: string; assistantDisplayName?: string },
): RuntimeMessagePayload["slackMessage"] | undefined {
  if (!slackMeta) return undefined;

  const slackConfig = getConfig().slack;
  const replyThreadTs =
    slackMeta.threadTs && slackMeta.threadTs !== slackMeta.channelTs
      ? slackMeta.threadTs
      : undefined;
  const messageLink = buildSlackMessageDeepLinks({
    teamId: slackConfig?.teamId,
    teamUrl: slackConfig?.teamUrl,
    channelId: slackMeta.channelId,
    messageTs: slackMeta.channelTs,
    ...(replyThreadTs ? { threadTs: replyThreadTs } : {}),
  });
  const threadLink = replyThreadTs
    ? buildSlackMessageDeepLinks({
        teamId: slackConfig?.teamId,
        teamUrl: slackConfig?.teamUrl,
        channelId: slackMeta.channelId,
        messageTs: replyThreadTs,
      })
    : undefined;
  const assistantDisplayName =
    opts?.role === "assistant" ? opts.assistantDisplayName : undefined;
  const senderDisplayName =
    slackMeta.displayName?.trim() || assistantDisplayName;

  return {
    channelId: slackMeta.channelId,
    ...(slackMeta.channelName ? { channelName: slackMeta.channelName } : {}),
    channelTs: slackMeta.channelTs,
    ...(slackMeta.threadTs ? { threadTs: slackMeta.threadTs } : {}),
    ...(senderDisplayName || slackMeta.actorExternalUserId
      ? {
          sender: {
            ...(senderDisplayName ? { displayName: senderDisplayName } : {}),
            ...(slackMeta.actorExternalUserId
              ? { externalUserId: slackMeta.actorExternalUserId }
              : {}),
          },
        }
      : {}),
    ...(messageLink ? { messageLink } : {}),
    ...(threadLink ? { threadLink } : {}),
    ...(slackMeta.eventKind ? { eventKind: slackMeta.eventKind } : {}),
    ...(slackMeta.reaction ? { reaction: slackMeta.reaction } : {}),
  };
}

function collectCanonicalGuardianRequestHintIds(
  conversationId: string,
  sourceChannel: string,
  conversation: Conversation,
): string[] {
  const requests = listPendingRequestsByConversationScope(
    conversationId,
    sourceChannel,
  );

  return requests
    .filter(
      (req) =>
        req.kind !== "tool_approval" ||
        conversation.hasPendingConfirmation(req.id),
    )
    .map((req) => req.id);
}

/**
 * Expire orphaned canonical guardian requests for a conversation.
 *
 * After the in-memory auto-deny loop runs, there may still be "pending"
 * canonical requests in the DB that have no corresponding in-memory
 * pending interaction (e.g. the prompter timed out and resolved the
 * confirmation directly without syncing canonical status). This sweep
 * catches those stragglers so they don't get falsely matched by the
 * guardian reply router on subsequent messages.
 *
 * Only expires requests *sourced from* (not merely delivered to) this
 * conversation. Delivered requests may still have live pending interactions
 * in their source conversation. Additionally skips requests that still
 * have a live in-memory pending interaction.
 *
 * Uses `listCanonicalGuardianRequests` (not `listPendingRequestsByConversationScope`)
 * so that time-expired requests (past their `expiresAt`) are also caught
 * instead of being silently filtered out.
 */
function expireOrphanedCanonicalRequests(conversationId: string): void {
  const sourceScoped = listCanonicalGuardianRequests({
    conversationId,
    status: "pending",
    kind: "tool_approval",
  });

  for (const req of sourceScoped) {
    // Skip requests that still have a live in-memory pending interaction —
    // they are not orphaned.
    if (pendingInteractions.get(req.id)) continue;

    resolveCanonicalGuardianRequest(req.id, "pending", {
      status: "expired",
    });
  }
}

async function tryConsumeCanonicalGuardianReply(params: {
  conversationId: string;
  sourceChannel: string;
  sourceInterface: string;
  content: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    filePath?: string;
  }>;
  conversation: Conversation;
  onEvent: (msg: ServerMessage) => void;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Verified actor identity from actor-token middleware. */
  verifiedActorExternalUserId?: string;
  /** Verified actor principal ID for principal-based authorization. */
  verifiedActorPrincipalId?: string;
  /** Originating client identifier for sync_changed self-echo suppression. */
  originClientId?: string;
}): Promise<{ consumed: boolean; messageId?: string }> {
  const {
    conversationId,
    sourceChannel,
    sourceInterface,
    content,
    attachments,
    conversation,
    onEvent,
    approvalConversationGenerator,
    verifiedActorExternalUserId,
    verifiedActorPrincipalId,
    originClientId,
  } = params;
  const trimmedContent = content.trim();

  if (trimmedContent.length === 0) {
    return { consumed: false };
  }

  const pendingRequestHintIds = collectCanonicalGuardianRequestHintIds(
    conversationId,
    sourceChannel,
    conversation,
  );
  // An empty hint set is `blocked`, not absence: the in-memory staleness
  // filter in collectCanonicalGuardianRequestHintIds found no live requests,
  // so the router must not fall back to identity/DB lookup (which rediscovered
  // stale canonical requests). A non-empty set scopes resolution to it.
  const pendingScope: GuardianPendingScope =
    pendingRequestHintIds.length > 0
      ? { mode: "scoped", requestIds: pendingRequestHintIds }
      : { mode: "blocked" };

  const routerResult = await routeGuardianReply({
    messageText: trimmedContent,
    channel: sourceChannel,
    actor: {
      actorPrincipalId: verifiedActorPrincipalId,
      actorExternalUserId: verifiedActorExternalUserId,
      channel: sourceChannel,
      guardianPrincipalId: verifiedActorPrincipalId,
    },
    conversationId,
    pendingScope,
    approvalConversationGenerator,
    emissionContext: {
      source: "inline_nl",
      decisionText: trimmedContent,
    },
  });

  if (!routerResult.consumed || routerResult.type === "nl_keep_pending") {
    return { consumed: false };
  }

  // Success-path emissions (approved/denied) are handled centrally
  // by handleConfirmationResponse (called via the resolver chain).
  // However, stale/failed paths never reach handleConfirmationResponse,
  // so we emit resolved_stale here for those cases.
  if (routerResult.requestId && !routerResult.decisionApplied) {
    conversation.emitConfirmationStateChanged({
      conversationId: conversationId,
      requestId: routerResult.requestId,
      state: "resolved_stale",
      source: "inline_nl",
      decisionText: trimmedContent,
    });
  }

  // Decision has been applied — transcript persistence is best-effort.
  // If DB writes fail, we still return consumed: true so the approval text
  // is not re-processed as a new user turn.
  let messageId: string | undefined;
  try {
    const channelMeta = buildChannelMetadata(sourceChannel, sourceInterface, {
      provenanceOverride: { provenanceTrustClass: "guardian" },
      attachments,
    });

    const cleanUserMessage = createUserMessage(content, attachments);
    const llmUserMessage = enrichMessageWithSourcePaths(
      cleanUserMessage,
      attachments,
    );
    const persistedUser = await addMessage(
      conversationId,
      "user",
      JSON.stringify(cleanUserMessage.content),
      { metadata: channelMeta },
    );
    messageId = persistedUser.id;

    const replyText =
      routerResult.replyText?.trim() ||
      (routerResult.decisionApplied
        ? "Decision applied."
        : "Request already resolved.");
    const assistantMessage = createAssistantMessage(replyText);
    const persistedAssistant = await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMessage.content),
      { metadata: channelMeta },
    );

    // Avoid mutating in-memory history / emitting stream deltas while a run is active.
    if (!conversation.isProcessing()) {
      conversation.getMessages().push(llmUserMessage, assistantMessage);
      onEvent({
        type: "assistant_text_delta",
        text: replyText,
        conversationId: conversationId,
      });
      emitCannedMessageComplete(onEvent, conversationId, persistedAssistant.id);
      // Both rows persisted above and no run is active (no unflushed stream
      // content), so advance the snapshot↔stream anchor past the events just
      // emitted. Otherwise `/messages` returns these rows while advertising
      // the previous anchor, under-claiming what the snapshot reflects.
      recordConversationPersistedSeq(conversationId, getCurrentSeq());
    }
    publishConversationMessagesChanged(conversationId, originClientId);
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist inline approval transcript entries",
    );
  }

  return { consumed: true, messageId };
}

/**
 * Render the live conversation's in-memory message queue into history rows.
 *
 * Messages enqueued while the agent is mid-turn live only in memory until the
 * queue drains and persists them, so they never reach the DB-sourced history
 * list. The live path surfaces them via `message_queued` SSE events; a cold
 * reload (no event replay) would otherwise drop them. Each queued row carries
 * `queueStatus: "queued"` with its 1-based `queuePosition` (mirroring the
 * client `DisplayMessage` queue fields) and is ordered FIFO so it appends to
 * the newest page in send order, mirroring how the agent will drain them.
 *
 * Returns an empty array when the conversation is not live in memory (cold, or
 * aged out of the registry) — there is no queue to read in that case.
 */
function buildQueuedMessagePayloads(
  conversationId: string,
): RuntimeMessagePayload[] {
  const conversation = findConversation(conversationId);
  if (!conversation) return [];

  // Hidden sends are suppressed from the transcript at every stage — echo,
  // persisted row, and here the in-memory queue window: a latest-page fetch
  // while the item still awaits drain must not surface it as a queued bubble.
  return conversation
    .snapshotQueuedMessages()
    .filter((item) => !isHiddenMessageMetadata(item.metadata))
    .map((item, index) => {
      const text = item.displayContent ?? item.content;
      const attachments: RuntimeAttachmentMetadata[] = item.attachments.map(
        (a, idx) => ({
          id: a.id ?? `${item.requestId}:attachment:${idx}`,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes:
            a.sizeBytes ?? (a.data ? Math.floor((a.data.length * 3) / 4) : 0),
          kind: classifyKind(a.mimeType),
          ...(a.mimeType.startsWith("image/") && a.data
            ? { data: a.data }
            : {}),
          ...(a.thumbnailData ? { thumbnailData: a.thumbnailData } : {}),
        }),
      );

      const contentBlocks: ConversationContentBlock[] = [];
      if (text.length > 0) contentBlocks.push({ type: "text", text });
      for (const attachment of attachments) {
        contentBlocks.push({ type: "attachment", attachment });
      }

      return {
        // The queued message has no DB row yet; its requestId is the stable
        // identifier the queued-message delete/steer endpoints key on.
        id: item.requestId,
        role: "user" as const,
        content: text,
        timestamp: new Date(item.sentAt).toISOString(),
        attachments,
        ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
        ...(item.clientMessageId
          ? { clientMessageId: item.clientMessageId }
          : {}),
        queueStatus: "queued" as const,
        queuePosition: index + 1,
      };
    });
}

export function handleListMessages({
  queryParams,
}: RouteHandlerArgs): Record<string, unknown> {
  const conversationId = queryParams?.conversationId;
  const conversationKey = queryParams?.conversationKey;

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    // Dual lookup, key-first: prefer the `conversation_keys` table — the
    // canonical channel/external → internal-id mapping — so legacy or
    // externally-sourced keys keep their explicit mapping precedence and
    // never collide with an unrelated `conversations.id`. Fall back to a
    // direct id lookup only when no mapping exists, which covers
    // background/scheduled conversations bootstrapped without a
    // `conversation_keys` row (web clients use the conversation list's
    // `id` as `conversationKey` for those).
    const mapping = getConversationByKey(conversationKey);
    if (mapping) {
      resolvedConversationId = mapping.conversationId;
    } else if (getConversation(conversationKey)) {
      resolvedConversationId = conversationKey;
    }
  } else {
    throw new BadRequestError(
      "conversationKey or conversationId query parameter is required",
    );
  }

  const beforeTimestampRaw = queryParams?.beforeTimestamp;
  const limitRaw = queryParams?.limit;
  const pageRaw = queryParams?.page;

  // Validate: reject NaN values with 400
  if (beforeTimestampRaw != null && isNaN(Number(beforeTimestampRaw))) {
    throw new BadRequestError("beforeTimestamp must be a valid number");
  }
  if (limitRaw != null && isNaN(Number(limitRaw))) {
    throw new BadRequestError("limit must be a valid number");
  }
  if (pageRaw != null && pageRaw !== "latest") {
    throw new BadRequestError("page must be 'latest' when provided");
  }
  const isLatestPage = pageRaw === "latest";

  if (!resolvedConversationId) {
    // Unresolved conversation keys still need to advertise the stable
    // `page=latest` contract so the web client can rely on metadata fields
    // being present even before any message is persisted.
    if (isLatestPage && beforeTimestampRaw == null) {
      return {
        messages: [],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: null,
        processing: false,
      };
    }
    return { messages: [] };
  }

  const beforeTimestamp = beforeTimestampRaw
    ? Number(beforeTimestampRaw)
    : undefined;
  // Clamp limit to 1-500 range
  const limit = limitRaw
    ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 500)
    : undefined;

  // Paginate when either `beforeTimestamp` (older-page request) or
  // `page=latest` (initial newest-N request) is set. When both are sent,
  // `beforeTimestamp` wins because the caller is explicitly asking for an
  // older page; `getMessagesPaginated` ignores `beforeTimestamp === undefined`
  // and returns the newest `limit` messages in chronological order.
  const isPaginated = beforeTimestamp != null || isLatestPage;

  let rawMessages: MessageRow[];
  let hasMore = false;
  // Resume cursor surfaced when the paginated scan stops on its row cap with a
  // (possibly empty) page — lets us still emit an oldest cursor so the client
  // can request the next window instead of stalling.
  let scanResumeCursor: { createdAt: number; id: string } | undefined;

  // Drop messages flagged as hidden in metadata (e.g. internal scaffolding
  // like retrospective instructions). The LLM-side history loader
  // (`getMessages` in memory/conversation-crud.ts) intentionally does not
  // filter — hidden messages remain in agent context but are suppressed from
  // the UI list. Filtering is pushed into the paginated query so `hasMore`
  // and the cursor reflect visible rows; otherwise a fully-hidden page would
  // return `hasMore: true` with no cursor and stall the web client.
  // Hidden tool_use/tool_result pairs must be hidden together — if a hidden
  // assistant message has tool_use blocks but its matching user tool_result
  // is left visible, the result will render as a standalone orphan because
  // `mergeToolResultsIntoAssistantMessages` has nothing to merge it into.
  //
  // Exception: memory-retrospective fork conversations show their hidden rows
  // (the retrospective instruction) so the run is readable as a distinct turn
  // and its LLM call is inspectable. The instruction row also separates the
  // copied source tail from the review turn, so `mergeConsecutiveAssistantMessages`
  // no longer folds the review into the source's last assistant message. This
  // is display-only and scoped to the fork source; the LLM-side `getMessages`
  // loader is unfiltered regardless.
  //
  // Only renderable roles reach this UI-facing transcript. `system` rows (a
  // permitted `MessageRole`, e.g. skill-authored context) are agent-context
  // scaffolding, never a displayed turn, so they are dropped here at the
  // source rather than narrowed away per-client.
  const isRetrospectiveFork =
    getConversation(resolvedConversationId)?.source ===
    MEMORY_RETROSPECTIVE_FORK_SOURCE;
  const visibleFilter = (m: MessageRow) =>
    (isRetrospectiveFork || !isHiddenMessage(m.metadata)) &&
    (m.role === "user" || m.role === "assistant");

  if (isPaginated) {
    const result = getMessagesPaginated(
      resolvedConversationId,
      limit,
      beforeTimestamp,
      visibleFilter,
    );
    rawMessages = result.messages;
    hasMore = result.hasMore;
    scanResumeCursor = result.nextCursor;
  } else {
    rawMessages = getMessages(resolvedConversationId).filter(visibleFilter);
  }

  // During streaming, tool_use (assistant) and tool_result (user) events are
  // assembled client-side into a single assistant ChatMessage. On reload, they
  // are separate DB rows. Merge tool_result blocks from user messages into the
  // preceding assistant message so renderHistoryContent can pair them via its
  // pendingToolUses map — otherwise they render as "Unknown" tool calls.
  const mergedMessages = mergeToolResultsIntoAssistantMessages(rawMessages);

  // During streaming, all assistant turns within one agent loop accumulate
  // on a single client-side ChatMessage (via currentAssistantMessageId).
  // In the DB, each API turn is a separate assistant row because
  // consolidation is deferred to compaction for prefix-cache stability.
  // Merge consecutive assistant messages here at query time so
  // renderHistoryContent produces the same contentOrder shape as streaming
  // (consecutive tool refs grouped together).
  const { messages: consolidatedMessages, mergedIdMap } =
    mergeConsecutiveAssistantMessages(mergedMessages);
  const assistantSlackDisplayName = getAssistantName()?.trim() || undefined;

  // Parse each row's stored content and per-message metadata. Rendering is
  // deferred to the serializer pass below so it runs after attachment
  // alignment, letting renderHistoryContent inline `attachment` blocks during
  // its single content walk.
  const parsed = consolidatedMessages.map((msg) => {
    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }

    // Extract sentAt from metadata for display timestamps. When a message
    // was queued or its persistence was delayed (long assistant generation),
    // sentAt captures the actual event time. Falls back to createdAt.
    let sentAt: number | undefined;
    let subagentNotification:
      | {
          subagentId: string;
          label: string;
          status: string;
          error?: string;
          conversationId?: string;
        }
      | undefined;
    let acpNotification: { acpSessionId: string; agent?: string } | undefined;
    let backgroundEventNotification: boolean | undefined;
    let backgroundToolCompletion: ConversationMessage["backgroundToolCompletion"];
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata);
        if (typeof meta.sentAt === "number") sentAt = meta.sentAt;
        // Every wake persists a `<background_event source="...">` trigger row
        // (see `persistWakeTriggerMessage`) that the LLM reads. Flag any such
        // row so clients hide it from the transcript like a subagent/ACP
        // notification — the user-facing "Conversation Woke" card (or, for a
        // backgrounded bash run, the inline terminal card) carries the status.
        if (typeof meta.backgroundEventSource === "string") {
          backgroundEventNotification = true;
        }
        // `persistWakeTriggerMessage` stamps the structured completion onto the
        // same wake row, letting the web rebuild a terminal inline card from
        // history after a restart (the in-memory completed ring does not survive).
        const completionParse = BackgroundToolCompletionSchema.safeParse(
          meta.backgroundToolCompletion,
        );
        if (completionParse.success) {
          backgroundToolCompletion = completionParse.data;
        }
        if (meta.subagentNotification) {
          const n = meta.subagentNotification;
          if (typeof n.subagentId === "string" && typeof n.label === "string") {
            subagentNotification = {
              subagentId: n.subagentId,
              label: n.label,
              status: typeof n.status === "string" ? n.status : "completed",
              ...(typeof n.error === "string" ? { error: n.error } : {}),
              ...(typeof n.conversationId === "string"
                ? { conversationId: n.conversationId }
                : {}),
              ...(typeof n.objective === "string"
                ? { objective: n.objective }
                : {}),
            };
          }
        }
        if (meta.acpNotification) {
          const n = meta.acpNotification;
          if (typeof n.acpSessionId === "string") {
            acpNotification = {
              acpSessionId: n.acpSessionId,
              ...(typeof n.agent === "string" ? { agent: n.agent } : {}),
            };
          }
        }
      } catch {
        // Ignore malformed metadata
      }
    }
    const slackMessage = buildSlackHistoryMessage(
      readSlackMetadataFromMessageMetadata(msg.metadata),
      {
        role: msg.role,
        assistantDisplayName: assistantSlackDisplayName,
      },
    );

    // `visibleFilter` has already dropped every non-renderable role, so the
    // only values reaching here are `user` and `assistant`; narrow the raw DB
    // `string` to the wire union.
    const role: "user" | "assistant" =
      msg.role === "assistant" ? "assistant" : "user";

    return {
      id: msg.id,
      role,
      content,
      createdAt: msg.createdAt,
      sentAt,
      subagentNotification,
      acpNotification,
      backgroundEventNotification,
      backgroundToolCompletion,
      slackMessage,
      clientMessageId: msg.clientMessageId ?? undefined,
    };
  });

  // Confirmation context layered onto rendered tool calls at render time: the
  // derived scope ladder for scope-aware tools, and any in-flight prompt read
  // from the pending-interactions registry. Both are computed once per request
  // and applied per message below.
  const workspaceDir = getWorkspaceDir();
  const pendingConfirmations = collectPendingConfirmations(
    resolvedConversationId,
  );
  const pendingQuestions = collectPendingQuestions(resolvedConversationId);

  const messages: RuntimeMessagePayload[] = parsed.map((m) => {
    const mergedMessageIds = m.id ? (mergedIdMap.get(m.id) ?? []) : [];

    // Hydrate the row's attachments from the DB. A metadata-only query avoids
    // loading large base64 blobs for non-image attachments (documents, audio);
    // full data is fetched only for images so the client can generate
    // thumbnails for inline display on history restore. Merged messages
    // (consecutive assistant merge) are queried too so their attachments
    // aren't lost before DB compaction relinks them.
    let msgAttachments: RuntimeAttachmentMetadata[] = [];
    if (m.id) {
      const idsToQuery = [m.id, ...mergedMessageIds];
      const linked = idsToQuery.flatMap((id) =>
        getAttachmentMetadataForMessage(id),
      );
      if (linked.length > 0) {
        msgAttachments = linked.map((a) => {
          // Hydrate image rows for inline thumbnails. Legacy HEIC can be
          // stored under application/octet-stream (empty File.type fallback),
          // so `.heic`/`.heif` rows are hydrated by filename too;
          // normalizeImageBase64 sniffs the bytes and rewrites only genuine
          // HEIF, which Chromium-based clients cannot decode. Filename and
          // sizeBytes keep describing the stored original, which
          // /attachments/:id/content serves verbatim for downloads.
          const isImage = a.mimeType.startsWith("image/");
          const isLegacyHeic = !isImage && isHeicFilename(a.originalFilename);
          const full =
            isImage || isLegacyHeic
              ? getAttachmentById(a.id, { hydrateFileData: true })
              : null;
          const display = full?.dataBase64
            ? normalizeImageBase64(a.mimeType, full.dataBase64)
            : null;
          // Image rows carry data even when unconverted (thumbnails); a
          // non-image row only becomes renderable once conversion yields a
          // JPEG, so it stays metadata-only when conversion is unavailable.
          const useDisplay =
            display && (isImage || display.converted) ? display : null;
          return {
            id: a.id,
            filename: a.originalFilename,
            mimeType: useDisplay?.mimeType ?? a.mimeType,
            sizeBytes: a.sizeBytes,
            kind: useDisplay?.converted
              ? classifyKind(useDisplay.mimeType)
              : a.kind,
            ...(useDisplay ? { data: useDisplay.dataBase64 } : {}),
            ...(a.thumbnailBase64 ? { thumbnailData: a.thumbnailBase64 } : {}),
            fileBacked: true,
          };
        });
      }
    }

    // Align the hydrated rows with the file-block refs, then render. Rendering
    // after alignment lets renderHistoryContent inline each `attachment` block
    // during its single content walk, so `contentBlocks` comes back ready to
    // ship with no post-processing. The aligned reorder/rewrite keeps the
    // legacy `attachments` array and `contentOrder` positions consistent.
    const attachmentRefs = collectAttachmentRefs(m.content);
    const aligned = alignAttachments(attachmentRefs, msgAttachments);
    msgAttachments = aligned.attachments;
    const attachmentBlocks = attachmentRefs.map(
      (_ref, refIdx) => aligned.refIndexToAttachment.get(refIdx) ?? null,
    );
    const rendered = renderHistoryContent(
      m.content,
      attachmentBlocks,
      m.id ?? undefined,
    );

    const toolCalls = enrichToolCallsWithQuestion(
      enrichToolCallsWithConfirmation(rendered.toolCalls, {
        workspaceDir,
        pendingConfirmations,
      }),
      { pendingQuestions },
    );

    // Strip <no_response/> markers from assistant messages so web/API clients
    // never see the raw sentinel. Only assistant messages produce it; user
    // messages are untouched. The filter is applied consistently to the flat
    // text, the segments, the contentOrder text refs, and the text blocks of
    // contentBlocks.
    let text = rendered.text;
    let textSegments = rendered.textSegments;
    let contentOrder = rendered.contentOrder;
    let contentBlocks = rendered.contentBlocks;
    if (m.role === "assistant") {
      const keepIndices: number[] = [];
      const filteredSegments: string[] = [];
      for (let i = 0; i < rendered.textSegments.length; i++) {
        const cleaned = rendered.textSegments[i]
          .replace(NO_RESPONSE_INLINE_RE, "")
          .trim();
        if (cleaned.length > 0) {
          keepIndices.push(i);
          filteredSegments.push(cleaned);
        }
      }
      const indexMap = new Map<number, number>();
      keepIndices.forEach((oldIdx, newIdx) => indexMap.set(oldIdx, newIdx));
      contentOrder = rendered.contentOrder
        .map((entry) => {
          const tm = entry.match(/^text:(\d+)$/);
          if (!tm) return entry;
          const newIdx = indexMap.get(Number(tm[1]));
          return newIdx !== undefined ? `text:${newIdx}` : undefined;
        })
        .filter((e): e is string => e !== undefined);
      textSegments = filteredSegments;
      text = rendered.text.replace(NO_RESPONSE_INLINE_RE, "").trim();
      contentBlocks = rendered.contentBlocks
        .map((block) =>
          block.type === "text"
            ? {
                type: "text" as const,
                text: block.text.replace(NO_RESPONSE_INLINE_RE, "").trim(),
              }
            : block,
        )
        .filter((block) => block.type !== "text" || block.text.length > 0);
    }

    // Ensure every hydrated attachment has a corresponding content block.
    // renderHistoryContent inlines attachment blocks only when it has
    // file-block refs with matching DB rows; directives (assistant-authored
    // <vellum-attachment/> tags) don't leave a file block after stripping,
    // so their attachments end up in the flat `attachments` array but not in
    // `contentBlocks`. Append any that are missing so the canonical
    // projection is complete.
    const existingAttachmentIds = new Set(
      contentBlocks
        .filter(
          (b): b is Extract<ConversationContentBlock, { type: "attachment" }> =>
            b.type === "attachment",
        )
        .map((b) => b.attachment.id),
    );
    for (const att of msgAttachments) {
      if (!existingAttachmentIds.has(att.id)) {
        contentBlocks.push({ type: "attachment", attachment: att });
      }
    }

    const alignedContentOrder = aligned.rewriteContentOrder(contentOrder);

    // Use sentAt (actual event time) for the display timestamp when available,
    // falling back to createdAt (persistence time). Clients use this display
    // timestamp as their pagination cursor after memory-pressure trimming,
    // while server-side pagination filters on createdAt. The mismatch is
    // benign — it may return slightly extra data on a page boundary but never
    // loses messages.
    const displayTimestamp = m.sentAt ?? m.createdAt;
    return {
      id: m.id ?? "",
      ...(mergedMessageIds.length > 0 ? { mergedMessageIds } : {}),
      ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
      role: m.role,
      // Flat plain-text body; see the `content` field on
      // ConversationMessageSchema for why this must stay.
      content: text,
      timestamp: new Date(displayTimestamp).toISOString(),
      attachments: msgAttachments,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(rendered.surfaces.length > 0 ? { surfaces: rendered.surfaces } : {}),
      ...(textSegments.length > 0 ? { textSegments } : {}),
      ...(rendered.thinkingSegments.length > 0
        ? { thinkingSegments: rendered.thinkingSegments }
        : {}),
      ...(alignedContentOrder.length > 0
        ? { contentOrder: alignedContentOrder }
        : {}),
      contentBlocks,
      ...(m.subagentNotification
        ? { subagentNotification: m.subagentNotification }
        : {}),
      ...(m.acpNotification ? { acpNotification: m.acpNotification } : {}),
      ...(m.backgroundEventNotification
        ? { backgroundEventNotification: true }
        : {}),
      ...(m.backgroundToolCompletion
        ? { backgroundToolCompletion: m.backgroundToolCompletion }
        : {}),
      ...(m.slackMessage ? { slackMessage: m.slackMessage } : {}),
    };
  });

  // Snapshot↔stream alignment token: the `seq` of the last event whose
  // content is durably persisted for this conversation, read from the
  // `conversations.seq` column. Returned on every resolved-conversation
  // response so a client can apply only stream events with a higher `seq`.
  // Null when nothing has been persisted (the conversation was created before
  // any stream activity, or predates the column) -- the client cold-starts.
  const persistedSeq = getConversationPersistedSeq(resolvedConversationId);

  // Authoritative "is the agent mid-turn?" signal, sourced from the
  // `processing_started_at` column (persisted, survives daemon restarts).
  // Clients use this to distinguish a live turn still in flight from a
  // turn that silently died — without it, a dropped SSE stream leaves the
  // UI spinning forever with no way to learn the server is actually idle.
  const processing = isConversationProcessing(resolvedConversationId);

  // Append the in-memory queue's pending user messages to the newest page so a
  // cold reload restores them alongside persisted history. They are the newest
  // rows in the conversation (enqueued during the in-flight turn) and are not
  // yet persisted, so they belong only on a request for the latest content —
  // never on an older-history page (`beforeTimestamp` set).
  if (beforeTimestamp == null) {
    messages.push(...buildQueuedMessagePayloads(resolvedConversationId));
  }

  if (isPaginated) {
    // Prefer the page's oldest visible row (the documented cursor semantic).
    // When a scan-cap-truncated page comes back empty there's no visible row
    // to anchor on, so fall back to the resume cursor so the client still gets
    // a `(timestamp, id)` to continue paginating from instead of stalling.
    const oldestTimestamp =
      rawMessages.length > 0
        ? rawMessages[0].createdAt
        : scanResumeCursor?.createdAt;
    const oldestMessageId =
      rawMessages.length > 0 ? rawMessages[0].id : scanResumeCursor?.id;
    // `page=latest` always emits both metadata fields so the web client has
    // a stable contract; emit `null` when the conversation is empty.
    // The existing `beforeTimestamp` branch keeps its conditional shape to
    // avoid disturbing current callers.
    if (isLatestPage && beforeTimestamp == null) {
      return {
        messages,
        hasMore,
        oldestTimestamp: oldestTimestamp ?? null,
        oldestMessageId: oldestMessageId ?? null,
        seq: persistedSeq,
        processing,
      };
    }

    return {
      messages,
      hasMore,
      ...(oldestTimestamp != null ? { oldestTimestamp } : {}),
      ...(oldestMessageId != null ? { oldestMessageId } : {}),
      seq: persistedSeq,
      processing,
    };
  }

  return { messages, seq: persistedSeq, processing };
}

/**
 * Persist the pre-chat onboarding payload to disk.
 *
 * Runs only on the very first message of a fresh conversation. Four
 * artifacts are produced:
 *
 *   1. `data/onboarding-context.json` — sidecar read by the
 *      relationship-state writer so onboarding-sourced facts survive
 *      the pure-recomputation write cycle (every turn boundary rebuilds
 *      facts from markdown; the sidecar is the durable source for the
 *      tool/task/tone chips).
 *   2. `IDENTITY.md` — assistant persona seed file, only written when
 *      missing so we never clobber existing content. Feeds the system
 *      prompt and the relationship-state writer's `parseIdentity`
 *      helper after a daemon restart when the in-memory onboarding
 *      context is gone.
 *   3. Onboarding section in the guardian persona file — written via
 *      `writeOnboardingSection`, which handles the user's preferred
 *      name (with fallback to root `USER.md`).
 *   4. `data/relationship-state.json` — kicked off fire-and-forget so
 *      the Home page can populate immediately on first visit instead
 *      of waiting for the first agent-turn boundary.
 *
 * Never throws: every write is guarded and logged as a warning on
 * failure. The route handler path must never reject because of a
 * best-effort persistence step.
 */
export function persistOnboardingArtifacts(onboarding: {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  occupation?: string;
  assistantName?: string;
  priorAssistants?: string[];
  cohort?: string;
  websiteUrl?: string;
  contentSourceUrl?: string;
}): void {
  writeOnboardingSidecar(onboarding);

  const assistantName = onboarding.assistantName?.trim();
  if (assistantName) {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    try {
      if (existsSync(identityPath)) {
        const content = readFileSync(identityPath, "utf-8");
        const updated = content.replace(
          /^- (?:\*\*)?Name:(?:\*\*)?\s*.*$/m,
          () => `- **Name:** ${assistantName}`,
        );
        if (updated !== content) {
          writeFileSync(identityPath, updated, "utf-8");
        }
      } else {
        writeFileSync(
          identityPath,
          `# Identity\n\n- **Name:** ${assistantName}\n`,
          "utf-8",
        );
      }
    } catch (err) {
      log.warn(
        { err, identityPath },
        "Failed to seed IDENTITY.md from onboarding",
      );
    }
  }

  try {
    const normalized = normalizeOnboardingContext(onboarding);
    writeOnboardingSection(normalized);
  } catch (err) {
    log.warn({ err }, "Failed to write onboarding section to persona file");
  }

  void writeRelationshipState().catch((err) => {
    log.warn(
      { err },
      "Failed to kick off relationship-state write after onboarding",
    );
  });
}

type ClientMetadataBag = Partial<Record<ClientMetadataField, string>>;

/**
 * Read the sanitized client-metadata headers (browser family/version, OS
 * surface, build version) sent by web-bundle clients. Values are persisted
 * under `metadata.client` on the user message, which `turn-events-store`
 * projects onto `TurnTelemetryEvent.client` for analytics. Returns
 * `undefined` when no valid header is present so callers can omit the bag.
 */
function readClientMetadataHeaders(
  headers: Record<string, string> | undefined,
): ClientMetadataBag | undefined {
  if (!headers) {
    return undefined;
  }
  const bag: ClientMetadataBag = {};
  for (const [field, headerName] of Object.entries(
    CLIENT_METADATA_HEADERS,
  ) as Array<[ClientMetadataField, string]>) {
    const value = sanitizeClientMetadataValue(headers[headerName]);
    if (value) {
      bag[field] = value;
    }
  }
  return Object.keys(bag).length > 0 ? bag : undefined;
}

/**
 * Attach the client-metadata bag to a persist-time metadata object under the
 * `client` key. Passes `metadata` through untouched (including `undefined`)
 * when there is no client metadata.
 */
function withClientMetadata(
  metadata: Record<string, unknown> | undefined,
  clientMetadata: ClientMetadataBag | undefined,
): Record<string, unknown> | undefined {
  if (!clientMetadata) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    client: clientMetadata,
  };
}

export async function handleSendMessage(
  { body: rawBody, headers }: RouteHandlerArgs,
  deps: {
    sendMessageDeps?: SendMessageDeps;
    approvalConversationGenerator?: ApprovalConversationGenerator;
  },
): Promise<unknown> {
  const body = (rawBody ?? {}) as {
    conversationKey?: string;
    conversationId?: string;
    content?: string;
    attachmentIds?: string[];
    sourceChannel?: string;
    interface?: string;
    conversationType?: string;
    automated?: boolean;
    // Persist the user message but suppress it from the UI transcript (kept in
    // LLM history). Used by flows like research-onboarding's "Let's chat"
    // handoff to prime a proactive assistant greeting without showing the
    // triggering user message. Honored on the standard send path only.
    hidden?: boolean;
    bypassSecretCheck?: boolean;
    hostHomeDir?: string;
    hostUsername?: string;
    clientTimezone?: unknown;
    clientOs?: unknown;
    clientId?: string;
    clientMessageId?: string;
    inferenceProfile?: string | null;
    enabledPlugins?: string[] | null;
    riskThreshold?: string;
    onboarding?: {
      tools: string[];
      tasks: string[];
      tone: string;
      userName?: string;
      assistantName?: string;
      googleConnected?: boolean;
      googleScopes?: string[];
      priorAssistants?: string[];
      cohort?: string;
      websiteUrl?: string;
      contentSourceUrl?: string;
      bootstrapTemplate?: string;
      initialMessage?: string;
      skills?: string[];
      title?: string;
    };
  };

  const actorPrincipalId = headers?.["x-vellum-actor-principal-id"];
  const principalType = headers?.["x-vellum-principal-type"];
  const originClientId = headers?.["x-vellum-client-id"]?.trim() || undefined;
  const clientMetadata = readClientMetadataHeaders(headers);

  const { conversationKey, content, attachmentIds } = body;
  const inboundConversationId =
    typeof body.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : undefined;
  const clientMessageId =
    typeof body.clientMessageId === "string" ? body.clientMessageId : undefined;
  const requestedInferenceProfile =
    typeof body.inferenceProfile === "string"
      ? body.inferenceProfile
      : undefined;
  const requestedRiskThreshold = body.riskThreshold;
  if (
    body.inferenceProfile != null &&
    typeof body.inferenceProfile !== "string"
  ) {
    throw new BadRequestError(
      "inferenceProfile must be a non-empty string or null",
    );
  }
  if (requestedInferenceProfile === "") {
    throw new BadRequestError(
      "inferenceProfile must be a non-empty string or null",
    );
  }
  if (requestedInferenceProfile !== undefined) {
    const profiles = getEffectiveProfiles(getConfig().llm.profiles);
    if (
      !Object.prototype.hasOwnProperty.call(profiles, requestedInferenceProfile)
    ) {
      throw new BadRequestError(
        `Profile "${requestedInferenceProfile}" is not defined in llm.profiles`,
      );
    }
  }
  // `undefined` leaves the stored scope untouched; `null` clears it to the
  // default; `[]` scopes the chat to no plugins.
  const requestedEnabledPlugins = body.enabledPlugins;
  if (
    requestedEnabledPlugins != null &&
    (!Array.isArray(requestedEnabledPlugins) ||
      requestedEnabledPlugins.some((p) => typeof p !== "string"))
  ) {
    throw new BadRequestError(
      "enabledPlugins must be an array of strings or null",
    );
  }
  if (
    requestedRiskThreshold !== undefined &&
    !isValidRiskThreshold(requestedRiskThreshold)
  ) {
    throw new BadRequestError(
      `riskThreshold must be one of: ${VALID_RISK_THRESHOLDS.join(", ")}`,
    );
  }
  if (!body.sourceChannel || typeof body.sourceChannel !== "string") {
    throw new BadRequestError("sourceChannel is required");
  }
  const sourceChannel = parseChannelId(body.sourceChannel);

  if (!sourceChannel) {
    throw new BadRequestError(
      `Invalid sourceChannel: ${
        body.sourceChannel
      }. Valid values: ${CHANNEL_IDS.join(", ")}`,
    );
  }

  if (!body.interface || typeof body.interface !== "string") {
    throw new BadRequestError("interface is required");
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    throw new BadRequestError(
      `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(
        ", ",
      )}`,
    );
  }
  const clientTimezone =
    typeof body.clientTimezone === "string"
      ? (canonicalizeTimeZone(body.clientTimezone) ?? undefined)
      : undefined;
  // Client OS surface ("web" | "ios" | "macos" | "android"), reported
  // separately from the transport `interface`. Validated against the dedicated
  // `ClientOs` value set (NOT the interface vocabulary) and only kept when it
  // resolves — it drives the per-turn `client_os:` context line, never
  // transport/host-proxy gating.
  const clientOs =
    typeof body.clientOs === "string"
      ? (parseClientOs(body.clientOs) ?? undefined)
      : undefined;

  // Reject non-string content values (numbers, objects, etc.)
  if (content != null && typeof content !== "string") {
    throw new BadRequestError("content must be a string");
  }

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const hasAttachments =
    Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    throw new BadRequestError("content or attachmentIds is required");
  }

  // Validate that all attachment IDs resolve
  if (hasAttachments) {
    const resolved = getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      throw new BadRequestError(
        `Attachment IDs not found: ${missing.join(", ")}`,
      );
    }
  }

  // Block messages containing known-format secrets before any persistence
  if (trimmedContent.length > 0 && !body.bypassSecretCheck) {
    const ingressResult = checkIngressForSecrets(trimmedContent);
    if (ingressResult.blocked) {
      return new RouteResponse(
        JSON.stringify({
          accepted: false,
          error: "secret_blocked",
          message: ingressResult.userNotice,
          detectedTypes: ingressResult.detectedTypes,
        }),
        { "content-type": "application/json" },
        422,
      );
    }
  }

  if (!deps.sendMessageDeps) {
    throw new RouteError(
      "Message processing is not available",
      "SERVICE_UNAVAILABLE",
      503,
    );
  }

  // Reject the legacy "private" mode explicitly rather than silently coercing
  // it to "standard" — clients that still populate this field expect privacy
  // semantics that no longer exist.
  if (body.conversationType === "private") {
    throw new BadRequestError(
      "Private conversations are no longer supported. Update your client to omit conversationType or send 'standard'.",
    );
  }

  // Desktop messages are always from the guardian — reset the heartbeat
  // timer so the next heartbeat is a full interval after this interaction.
  HeartbeatService.getInstance()?.resetTimer();

  // Resolve the target conversation. Fetch by `conversationId` (the
  // assistant-minted internal id) when the client supplies it — clients
  // must obtain this id from a prior daemon response, so a missing row
  // is a 404. Otherwise fall through to the external-key path: the
  // client-supplied `conversationKey` (external-key lookup; materializes
  // on first use) or, when neither is provided, a channel-dependent
  // default. The vellum channel mints a fresh conversation on every
  // empty-handed send so first-message-of-a-new-chat surfaces with a
  // server-minted id; other channels (phone, slack, …) share a stable
  // `default:<channel>:<interface>` thread so repeated calls from the
  // same channel/interface stay co-located.
  let mapping: {
    conversationId: string;
    conversationType: string;
    created: boolean;
  };
  if (inboundConversationId !== undefined) {
    const existing = getConversation(inboundConversationId);
    if (!existing) {
      throw new NotFoundError(
        `Conversation ${inboundConversationId} not found`,
      );
    }
    mapping = {
      conversationId: existing.id,
      conversationType: existing.conversationType,
      created: false,
    };
  } else {
    const resolvedConversationKey =
      conversationKey && conversationKey.length > 0
        ? conversationKey
        : sourceChannel === "vellum"
          ? crypto.randomUUID()
          : `default:${sourceChannel}:${sourceInterface}`;
    // An onboarding flow may supply an explicit title for the conversation it
    // mints behind the scenes (e.g. the research pass) so it isn't left with an
    // auto-generated title. Applied only when this call creates the row.
    const onboardingTitle = body.onboarding?.title?.trim() || undefined;
    mapping = getOrCreateConversation(resolvedConversationKey, {
      conversationType: "standard",
      title: onboardingTitle,
    });
  }

  if (requestedRiskThreshold !== undefined) {
    const result = await ipcCall("set_conversation_threshold", {
      conversationId: mapping.conversationId,
      threshold: requestedRiskThreshold,
    });
    if (result === undefined) {
      log.error(
        {
          conversationId: mapping.conversationId,
          threshold: requestedRiskThreshold,
        },
        "Failed to set conversation risk threshold override via gateway IPC",
      );
      throw new InternalError("Failed to persist risk threshold override");
    }
  }

  const smDeps = deps.sendMessageDeps;

  // Notify all connected clients that the conversation list changed when
  // this is the first message in a standard conversation, so sidebars on
  // other devices can refresh. We check for first-message rather than
  // first-create because the SSE subscribe handler (events-routes.ts) may
  // have already materialised the conversation from a draft key before any
  // message was sent — in that case `mapping.created` is `false` even
  // though, from the user's perspective, this is a brand-new conversation
  // that other clients don't yet know about.
  if (mapping.conversationType === "standard") {
    if (!hasMessages(mapping.conversationId)) {
      publishConversationListAndMetadataChanged(
        "created",
        mapping.conversationId,
        originClientId,
      );
    }
  }

  // Build transport metadata from the request so the daemon can inject
  // host environment hints (home directory, username) into the LLM context.
  // The `supportsHostProxy` type predicate narrows `sourceInterface` to
  // `HostProxyInterfaceId` in the truthy branch, which is exactly the
  // discriminant the `HostProxyTransportMetadata` variant expects — so the
  // construction site stays in lock-step with the runtime capability gate.
  const transport = supportsHostProxy(sourceInterface)
    ? ({
        channelId: sourceChannel,
        interfaceId: sourceInterface,
        hostHomeDir: body.hostHomeDir,
        hostUsername: body.hostUsername,
        ...(clientTimezone ? { clientTimezone } : {}),
        ...(clientOs ? { clientOs } : {}),
      } satisfies HostProxyTransportMetadata)
    : ({
        channelId: sourceChannel,
        interfaceId: sourceInterface,
        ...(clientTimezone ? { clientTimezone } : {}),
        ...(clientOs ? { clientOs } : {}),
      } satisfies NonHostProxyTransportMetadata);

  const conversation = await smDeps.getOrCreateConversation(
    mapping.conversationId,
    { transport },
  );

  if (requestedInferenceProfile !== undefined) {
    setConversationInferenceProfile(
      mapping.conversationId,
      requestedInferenceProfile,
    );
    conversation.applyInferenceProfileState({
      profile: requestedInferenceProfile,
      sessionId: null,
      expiresAt: null,
    });
  }

  if (requestedEnabledPlugins !== undefined) {
    conversation.setEnabledPlugins(requestedEnabledPlugins);
  }

  // Store pre-chat onboarding context on the conversation when this is the
  // very first message (no prior messages loaded). Artifact persistence
  // (IDENTITY.md, USER.md, sidecar) runs before either the canned greeting
  // broadcast or normal LLM inference so client-side identity reads observe
  // the selected assistant name.
  const isFirstOnboarding =
    !!body.onboarding && conversation.messages.length === 0;
  if (isFirstOnboarding) {
    conversation.setOnboardingContext(body.onboarding!);
  }

  // Resolve guardian context from the AuthContext's actorPrincipalId via the
  // gateway guardian binding: a vellum principal is the guardian or nobody.
  if (actorPrincipalId) {
    // Dev bypass (HTTP auth disabled): the synthetic "dev-bypass" principal
    // won't match any guardian binding. Resolve the real guardian principal and
    // map that through, failing closed to unknown on an empty gateway.
    if (isHttpAuthDisabled() && actorPrincipalId === "dev-bypass") {
      const guardianPrincipalId = await findLocalGuardianPrincipalId();
      let trustCtx: TrustContext = guardianPrincipalId
        ? withSourceChannel(
            sourceChannel,
            await resolveLocalPrincipalTrustContext({
              actorPrincipalId: guardianPrincipalId,
              sourceChannel: "vellum",
              conversationExternalId: "local",
            }),
          )
        : { trustClass: "unknown", sourceChannel };
      if (guardianPrincipalId && trustCtx.trustClass === "unknown") {
        const healed = await reResolveTrustOnResetDrift(
          guardianPrincipalId,
          sourceChannel,
        );
        if (healed) trustCtx = healed;
      }
      conversation.setTrustContext(trustCtx);
    } else {
      let trustCtx = withSourceChannel(
        sourceChannel,
        await resolveLocalPrincipalTrustContext({
          actorPrincipalId,
          sourceChannel: "vellum",
          conversationExternalId: "local",
        }),
      );
      if (trustCtx.trustClass === "unknown") {
        const healed = await reResolveTrustOnResetDrift(
          actorPrincipalId,
          sourceChannel,
        );
        if (healed && healed.trustClass !== "unknown") {
          trustCtx = healed;
          log.info(
            { actorPrincipalId, trustClass: trustCtx.trustClass },
            "Trust re-resolved from local mirror after gateway returned unknown",
          );
        } else {
          log.warn(
            {
              actorPrincipalId,
              sourceChannel,
              trustClass: "unknown",
              principalType,
            },
            "JWT-verified actor resolved to unknown trust class — possible guardian binding drift (e.g. DB reset without re-bootstrap)",
          );
        }
      }
      conversation.setTrustContext(trustCtx);
    }
  } else {
    // Service principals (svc_gateway) or tokens without an actor ID
    // get a minimal guardian context so downstream code has something.
    conversation.setTrustContext({ trustClass: "guardian", sourceChannel });
  }

  const isInteractive = isInteractiveInterface(sourceInterface);
  // Translate the dev-bypass actor principal to the real guardian principal
  // before the same-actor host-proxy gate so web/iOS turns match the macOS
  // client's SSE-registered principal. No-op for real JWT principals in
  // non-dev-bypass deployments.
  const sourceActorPrincipalId = await resolveActorPrincipalIdForLocalGuardian(
    actorPrincipalId ?? undefined,
  );
  // Bash/File/Transfer singletons are globally available via isAvailable() —
  // no per-conversation gating needed. CU is per-conversation (owns step
  // count, AX tree history, loop detection).
  if (
    shouldAttachHostProxyForCapability(
      "host_cu",
      sourceInterface,
      sourceActorPrincipalId,
    )
  ) {
    if (!conversation.isProcessing() || !conversation.hostCuProxy) {
      conversation.setHostCuProxy(new HostCuProxy());
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostCuProxy(undefined);
  }
  // App-control mirrors CU's per-conversation lifecycle: the proxy owns a
  // singleton lock plus per-session loop tracking. Instantiation is
  // unconditional when the capability is reachable — feature-flag gating
  // lives in the skill-projection layer (which reads the `feature-flag:
  // app-control` declaration in SKILL.md frontmatter), so an attached proxy
  // is harmless when the flag resolves to off.
  if (
    shouldAttachHostProxyForCapability(
      "host_app_control",
      sourceInterface,
      sourceActorPrincipalId,
    )
  ) {
    if (!conversation.isProcessing() || !conversation.hostAppControlProxy) {
      conversation.setHostAppControlProxy(
        new HostAppControlProxy(mapping.conversationId),
      );
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostAppControlProxy(undefined);
  }
  // Only preactivate when the conversation is idle — if it's processing,
  // this message will be queued and preactivation is deferred to dequeue
  // time in drainQueueImpl to avoid mutating in-flight turn state.
  if (!conversation.isProcessing()) {
    preactivateHostProxySkills(
      conversation,
      sourceInterface,
      sourceActorPrincipalId,
    );
  }
  // Wire sendToClient to the SSE hub so all subsystems can reach the HTTP client.
  // hasNoClient must remain `!isInteractive` so downstream tool gating
  // (`isToolActiveForContext` for HOST_TOOL_NAMES, `createToolExecutor`'s
  // `isInteractive: !ctx.hasNoClient`) keeps host_bash/host_file/host_cu
  // tools gated for non-desktop interfaces. The chrome-extension interface
  // is non-interactive (no SSE prompter UI) but still has a connected client
  // that can service host_browser_request events; we restore that single
  // proxy explicitly below without relaxing `hasNoClient`.
  conversation.updateClient(broadcastMessage, !isInteractive);
  if (isInteractive) {
    getSubagentManager().updateParentSender(
      mapping.conversationId,
      broadcastMessage,
    );
  }

  // ── URL scan path: rewrite first message for scan onboarding ──
  // When onboarding provides a websiteUrl or contentSourceUrl and the
  // first message is the macOS wake-up greeting, bypass the canned
  // greeting and rewrite the user message to a scan instruction so real
  // LLM inference runs against the URL.
  const sanitizeUrl = (u?: string) =>
    u?.trim().replace(/[\r\n\t]/g, "") || undefined;
  const websiteUrl = sanitizeUrl(body.onboarding?.websiteUrl);
  const contentSourceUrl = sanitizeUrl(body.onboarding?.contentSourceUrl);
  const scanUrl = websiteUrl || contentSourceUrl;
  const isWakeUp = isWakeUpGreeting(
    trimmedContent,
    conversation.getMessages().length,
  );
  const isScanPath = !!scanUrl && isWakeUp;
  // Self-intro path: when we know a name, send a natural introduction on the
  // user's behalf instead of the canned greeting, so the assistant generates a
  // real first response. Gated behind the `self-intro-greeting` flag (default
  // off); `undefined` (flag off or no names) falls back to the canned path.
  const selfIntroGreetingEnabled =
    isWakeUp &&
    isAssistantFeatureFlagEnabled(SELF_INTRO_GREETING_FLAG, getConfig());
  const selfIntro = selfIntroGreetingEnabled
    ? buildSelfIntroMessage(body.onboarding ?? undefined)
    : undefined;

  let effectiveContent: string | undefined;
  if (isScanPath) {
    const scanVariant = websiteUrl
      ? ("website" as const)
      : ("content-source" as const);
    effectiveContent = buildScanFirstMessage(scanUrl, scanVariant);
    // Fall through to normal inference path below
  } else if (selfIntroGreetingEnabled && body.onboarding?.initialMessage) {
    effectiveContent = body.onboarding.initialMessage;
  } else if (isWakeUp && selfIntro) {
    // Rewrite to the self-introduction and fall through to real inference
    // (mirrors the scan path above).
    effectiveContent = selfIntro;
  } else if (isWakeUp) {
    const cannedGreeting = getCannedFirstGreeting(body.onboarding ?? undefined);

    conversation.setProcessing(true);
    let cleanupDeferred = false;
    try {
      const rawContent = content ?? "";
      const attachments = hasAttachments
        ? smDeps.resolveAttachments(attachmentIds)
        : [];
      const greetingMeta = {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
      };
      const persisted = await persistQueuedMessageBody(conversation, {
        content: rawContent,
        attachments,
        requestId: crypto.randomUUID(),
        metadata: greetingMeta,
        clientMessageId,
      });

      const conversationId = mapping.conversationId;
      const channelMeta = buildChannelMetadata(sourceChannel, sourceInterface, {
        trustContext: conversation.trustContext,
      });

      const assistantMsg = createAssistantMessage(cannedGreeting);
      const persistedAssistant = await addMessage(
        mapping.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: channelMeta },
      );
      conversation.getMessages().push(assistantMsg);

      const response = {
        accepted: true,
        messageId: persisted.id,
        conversationId,
      };

      if (isFirstOnboarding) {
        persistOnboardingArtifacts(body.onboarding!);
        try {
          recordOnboardingEvent({
            screen: "complete",
            tools: body.onboarding!.tools,
            tasks: body.onboarding!.tasks,
            tone: body.onboarding!.tone,
            googleConnected: body.onboarding!.googleConnected,
            googleScopes: body.onboarding!.googleScopes,
            priorAssistants: body.onboarding!.priorAssistants,
          });
        } catch (err) {
          log.warn({ err }, "Failed to record onboarding telemetry event");
        }
      }

      setTimeout(() => {
        broadcastMessage({
          type: "user_message_echo",
          text: rawContent,
          conversationId,
          messageId: persisted.id,
          clientMessageId,
        });
        broadcastMessage({
          type: "assistant_text_delta",
          text: cannedGreeting,
          conversationId,
        });
        emitCannedMessageComplete(
          broadcastMessage,
          conversationId,
          persistedAssistant.id,
        );
        // Rows persisted before this deferred burst; advance the
        // snapshot↔stream anchor past the events just emitted so `/messages`
        // never returns these rows behind a stale anchor.
        recordConversationPersistedSeq(conversationId, getCurrentSeq());
        publishConversationMessagesChanged(conversationId, originClientId);
        conversation.setProcessing(false);
        silentlyWithLog(
          conversation.drainQueue(),
          "canned-greeting queue drain",
        );

        conversation.warmPromptCache();
      }, 0);

      log.info(
        { conversationId, personalized: !!body.onboarding },
        "Served canned first greeting — skipped LLM inference",
      );
      cleanupDeferred = true;
      return response;
    } finally {
      if (!cleanupDeferred && conversation.isProcessing()) {
        conversation.setProcessing(false);
        silentlyWithLog(conversation.drainQueue(), "error-path queue drain");
      }
    }
  }

  if (isFirstOnboarding) {
    persistOnboardingArtifacts(body.onboarding!);
    try {
      recordOnboardingEvent({
        screen: "complete",
        tools: body.onboarding!.tools,
        tasks: body.onboarding!.tasks,
        tone: body.onboarding!.tone,
        googleConnected: body.onboarding!.googleConnected,
        googleScopes: body.onboarding!.googleScopes,
        priorAssistants: body.onboarding!.priorAssistants,
      });
    } catch (err) {
      log.warn({ err }, "Failed to record onboarding telemetry event");
    }
  }

  // When the scan path rewrote the first message, prefer the rewritten
  // content for all downstream consumers (guardian reply, enqueue, agent
  // loop) so they see the scan instruction rather than the wake-up greeting.
  const contentAfterScan = effectiveContent ?? content ?? "";

  const attachments = hasAttachments
    ? smDeps.resolveAttachments(attachmentIds)
    : [];

  // Resolve the verified actor's external user ID and principal for inline
  // approval routing from the conversation's guardian context.
  const verifiedActorExternalUserId =
    conversation.trustContext?.guardianExternalUserId;
  const verifiedActorPrincipalId =
    conversation.trustContext?.guardianPrincipalId ?? undefined;

  // Try to consume the message as a canonical guardian approval/rejection reply.
  // On failure, degrade to the existing queue/auto-deny path rather than
  // surfacing a 500 — mirrors the handler's catch-and-fallback.
  try {
    const inlineReplyResult = await tryConsumeCanonicalGuardianReply({
      conversationId: mapping.conversationId,
      sourceChannel,
      sourceInterface,
      content: contentAfterScan,
      attachments,
      conversation,
      onEvent: broadcastMessage,
      // Desktop path: disable NL classification to avoid consuming non-decision
      // messages while a tool confirmation is pending. Deterministic code-prefix
      // and callback parsing remain active. Mirrors conversation-process.ts behavior.
      approvalConversationGenerator:
        sourceChannel === "vellum"
          ? undefined
          : deps.approvalConversationGenerator,
      verifiedActorExternalUserId,
      verifiedActorPrincipalId,
      originClientId,
    });
    if (inlineReplyResult.consumed) {
      return {
        accepted: true,
        conversationId: mapping.conversationId,
        ...(inlineReplyResult.messageId
          ? { messageId: inlineReplyResult.messageId }
          : {}),
      };
    }
  } catch (err) {
    log.warn(
      { err, conversationId: mapping.conversationId },
      "Inline approval consumption failed, falling through to normal send path",
    );
  }

  if (conversation.isProcessing()) {
    // Queue the message so it's processed when the current turn completes
    const requestId = crypto.randomUUID();
    const enqueueResult = conversation.enqueueMessage({
      content: contentAfterScan,
      attachments,
      onEvent: broadcastMessage,
      requestId,
      metadata: withClientMetadata(
        {
          userMessageChannel: sourceChannel,
          assistantMessageChannel: sourceChannel,
          userMessageInterface: sourceInterface,
          assistantMessageInterface: sourceInterface,
          ...(body.automated === true ? { automated: true } : {}),
          // Carry the transcript-suppression flag through the queue so a
          // hidden send that lands mid-turn stays hidden when drained —
          // the drain path persists this metadata and skips the echo.
          ...(body.hidden === true ? { hidden: true } : {}),
        },
        clientMetadata,
      ),
      isInteractive,
      sourceActorPrincipalId,
      transport,
      clientMessageId,
    });
    if (enqueueResult.rejected) {
      return new RouteResponse(
        JSON.stringify({ accepted: false, error: "queue_full" }),
        { "content-type": "application/json" },
        429,
      );
    }

    // Auto-deny pending confirmations only after enqueue succeeds, so we
    // don't cancel approval-gated workflows when the replacement message
    // is itself rejected by the queue budget.
    // Wrapped in try-catch: the message is already enqueued, so a failure
    // here must not turn the 202 response into a 500 — that would leave
    // the client showing "Failed to send" for a message the daemon will
    // process from the queue.
    //
    // Supersede encodes user intent — a typed message while a prompt is open
    // means the user chose to move on. A hidden send is a machine signal
    // (e.g. the channel-setup wizard-close marker), not a user decision: it
    // must not auto-deny live approval prompts or steer a parked
    // ask_question to a message the user never typed. Daemon-injected
    // synthetic messages (subagent/ACP notifications) skip this path the
    // same way by enqueuing directly.
    if (body.hidden !== true) {
      try {
        // Supersede interactions left pending by the in-flight turn: auto-deny
        // confirmations (with canonical/client sync) and steer to the enqueued
        // message if an ask_question is parked. Centralized so the CLI signal
        // path (signals/user-message.ts) gets identical handling.
        supersedePendingInteractionsOnEnqueue(
          mapping.conversationId,
          requestId,
        );

        // Expire any orphaned canonical requests that survived without a
        // matching in-memory pending interaction (e.g. prompter timeouts).
        expireOrphanedCanonicalRequests(mapping.conversationId);
      } catch (err) {
        log.warn(
          { err, conversationId: mapping.conversationId },
          "Post-enqueue auto-deny failed — queued message unaffected",
        );
      }
    }

    return {
      accepted: true,
      queued: true,
      conversationId: mapping.conversationId,
      requestId,
    };
  }

  // Auto-deny pending confirmations for idle conversations. The legacy
  // handleUserMessage called autoDenyPendingConfirmations unconditionally
  // before dispatching, so an idle conversation with lingering confirmations
  // (e.g. the user never responded to a tool-approval prompt) must deny
  // them before starting the new turn.
  // Hidden sends are machine signals, not user decisions — like the queue
  // branch's supersede bypass above, they must not deny confirmations that
  // outlived a turn (e.g. a guardian approval still awaiting a channel
  // reply). The next visible send performs the cleanup instead.
  if (body.hidden !== true && conversation.hasAnyPendingConfirmation()) {
    for (const interaction of pendingInteractions.getByConversation(
      mapping.conversationId,
    )) {
      if (interaction.kind === "confirmation") {
        conversation.emitConfirmationStateChanged({
          conversationId: mapping.conversationId,
          requestId: interaction.requestId,
          state: "denied" as const,
          source: "auto_deny" as const,
        });
        // Sync canonical guardian request status so stale "pending" DB
        // records don't get matched by later guardian reply routing.
        resolveCanonicalGuardianRequest(interaction.requestId, "pending", {
          status: "denied",
        });
      }
    }
    conversation.denyAllPendingConfirmations();
    pendingInteractions.removeByConversation(mapping.conversationId);
  }

  // Expire any orphaned canonical requests that survived without a
  // matching in-memory pending interaction (e.g. prompter timeouts).
  expireOrphanedCanonicalRequests(mapping.conversationId);

  // Conversation is idle — persist and fire agent loop immediately
  conversation.setTurnChannelContext({
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
  });
  conversation.setTurnInterfaceContext({
    userMessageInterface: sourceInterface,
    assistantMessageInterface: sourceInterface,
  });
  conversation.currentTurnSourceActorPrincipalId = sourceActorPrincipalId;

  await conversation.ensureActorScopedHistory();

  // Resolve slash commands before persisting or running the agent loop.
  // `contentAfterScan` already carries the scan-rewritten content when
  // applicable; reuse it here for consistency.
  const rawContent = contentAfterScan;
  const slashContext = buildSlashContextForContent(rawContent, {
    conversationId: mapping.conversationId,
    messageCount: conversation.getMessages().length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: sourceInterface,
  });
  const slashResult = await resolveSlash(rawContent, slashContext);

  if (slashResult.kind === "unknown") {
    conversation.setProcessing(true);
    let cleanupDeferred = false;
    try {
      const slashMeta = {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
        ...(body.automated === true ? { automated: true } : {}),
      };
      const persisted = await persistQueuedMessageBody(conversation, {
        content: rawContent,
        attachments,
        requestId: crypto.randomUUID(),
        metadata: withClientMetadata(slashMeta, clientMetadata),
        clientMessageId,
      });
      if (persisted.deduplicated) {
        return {
          accepted: true,
          messageId: persisted.id,
          conversationId: mapping.conversationId,
        };
      }

      const channelMeta = buildChannelMetadata(sourceChannel, sourceInterface, {
        trustContext: conversation.trustContext,
      });
      const assistantMsg = createAssistantMessage(slashResult.message);
      const persistedAssistant = await addMessage(
        mapping.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: channelMeta },
      );
      conversation.getMessages().push(assistantMsg);

      // Snapshot model info now so the deferred callback cannot observe
      // a config change from a concurrent request.
      const modelInfoEvent = isModelSlashCommand(rawContent)
        ? await buildModelInfoEvent(mapping.conversationId)
        : null;

      const response = {
        accepted: true,
        messageId: persisted.id,
        conversationId: mapping.conversationId,
      };

      // Defer event publishing to next tick so the HTTP response reaches the
      // client first. This ensures the client's serverToLocalConversationMap is
      // populated before SSE events arrive, preventing dropped events in new
      // desktop conversations.
      //
      // conversation.processing and drainQueue are also deferred so the current
      // slash command's events are emitted before the next queued message
      // starts processing.
      const conversationId = mapping.conversationId;
      const message = slashResult.message;
      setTimeout(() => {
        broadcastMessage({
          type: "user_message_echo",
          text: rawContent,
          conversationId,
          messageId: persisted.id,
          clientMessageId,
        });
        if (modelInfoEvent) {
          broadcastMessage(modelInfoEvent);
        }
        broadcastMessage({
          type: "assistant_text_delta",
          text: message,
          conversationId,
        });
        emitCannedMessageComplete(
          broadcastMessage,
          conversationId,
          persistedAssistant.id,
        );
        // Same anchor advance as the canned-greeting path above.
        recordConversationPersistedSeq(conversationId, getCurrentSeq());
        publishConversationMessagesChanged(conversationId, originClientId);
        conversation.setProcessing(false);
        silentlyWithLog(conversation.drainQueue(), "slash-command queue drain");
      }, 0);

      cleanupDeferred = true;
      return response;
    } finally {
      // No-op for the slash-command early-return path (handled inside
      // setTimeout above), but still needed for error paths.
      if (!cleanupDeferred && conversation.isProcessing()) {
        conversation.setProcessing(false);
        silentlyWithLog(conversation.drainQueue(), "error-path queue drain");
      }
    }
  }

  if (slashResult.kind === "compact") {
    conversation.setProcessing(true);
    const slashMeta = {
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
      userMessageInterface: sourceInterface,
      assistantMessageInterface: sourceInterface,
    };
    let persisted: Awaited<ReturnType<typeof persistQueuedMessageBody>>;
    try {
      persisted = await persistQueuedMessageBody(conversation, {
        content: rawContent,
        attachments,
        requestId: crypto.randomUUID(),
        metadata: withClientMetadata(slashMeta, clientMetadata),
        clientMessageId,
      });
    } catch (err) {
      // The fire-and-forget compaction below owns clearing `processing`, but a
      // throw from this initial persist never reaches it — reset here so the
      // conversation isn't stranded in queued mode.
      conversation.setProcessing(false);
      silentlyWithLog(conversation.drainQueue(), "compact-command queue drain");
      throw err;
    }
    if (persisted.deduplicated) {
      conversation.setProcessing(false);
      silentlyWithLog(conversation.drainQueue(), "compact-dedup queue drain");
      return {
        accepted: true,
        messageId: persisted.id,
        conversationId: mapping.conversationId,
      };
    }

    const conversationId = mapping.conversationId;
    const channelMeta = buildChannelMetadata(sourceChannel, sourceInterface, {
      trustContext: conversation.trustContext,
    });

    // Fire-and-forget: return 202 immediately, run compaction async.
    // forceCompact() makes an LLM call that can exceed the client's
    // HTTP timeout on large contexts, causing a false "Failed to send".
    (async () => {
      let assistantMessagePersisted = false;
      try {
        broadcastMessage({
          type: "user_message_echo",
          text: rawContent,
          conversationId,
          messageId: persisted.id,
          clientMessageId,
        });
        publishConversationMessagesChanged(conversationId, originClientId);
        conversation.emitActivityState("thinking", "context_compacting");
        const result = await conversation.forceCompact();
        const responseText = formatCompactResult(result);

        const assistantMsg = createAssistantMessage(responseText);
        const persistedAssistant = await addMessage(
          conversationId,
          "assistant",
          JSON.stringify(assistantMsg.content),
          { metadata: channelMeta },
        );
        assistantMessagePersisted = true;
        conversation.getMessages().push(assistantMsg);

        broadcastMessage({
          type: "assistant_text_delta",
          text: responseText,
          conversationId,
        });
        emitCannedMessageComplete(
          broadcastMessage,
          conversationId,
          persistedAssistant.id,
        );
        // Same anchor advance as the canned-greeting path above.
        recordConversationPersistedSeq(conversationId, getCurrentSeq());
        publishConversationMessagesChanged(conversationId, originClientId);
      } catch (err) {
        if (assistantMessagePersisted) {
          publishConversationMessagesChanged(conversationId, originClientId);
        }
        log.error({ err, conversationId }, "Compact command failed");
        broadcastMessage({
          type: "conversation_error",
          conversationId,
          code: "UNKNOWN",
          userMessage: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      } finally {
        conversation.setProcessing(false);
        silentlyWithLog(
          conversation.drainQueue(),
          "compact-command queue drain",
        );
      }
    })();

    return {
      accepted: true,
      messageId: persisted.id,
      conversationId,
    };
  }

  if (slashResult.kind === "clean") {
    conversation.setProcessing(true);
    const conversationId = mapping.conversationId;
    // Outer try/finally guarantees the processing flag is cleared (and the
    // queue drained) on every failure path — including a throw from the
    // initial user-message persist below, which would otherwise leave the
    // conversation stuck in queued mode indefinitely.
    try {
      const slashMeta = {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
      };
      const persisted = await persistQueuedMessageBody(conversation, {
        content: rawContent,
        attachments,
        requestId: crypto.randomUUID(),
        metadata: withClientMetadata(slashMeta, clientMetadata),
        clientMessageId,
      });
      if (persisted.deduplicated) {
        return {
          accepted: true,
          messageId: persisted.id,
          conversationId,
        };
      }

      const channelMeta = buildChannelMetadata(sourceChannel, sourceInterface, {
        trustContext: conversation.trustContext,
      });
      let assistantMessagePersisted = false;
      try {
        broadcastMessage({
          type: "user_message_echo",
          text: rawContent,
          conversationId,
          messageId: persisted.id,
          clientMessageId,
        });
        publishConversationMessagesChanged(conversationId, originClientId);

        const result = await conversation.forceClean();
        const responseText = formatCleanResult(result);

        const assistantMsg = createAssistantMessage(responseText);
        const persistedAssistant = await addMessage(
          conversationId,
          "assistant",
          JSON.stringify(assistantMsg.content),
          { metadata: channelMeta },
        );
        assistantMessagePersisted = true;
        conversation.getMessages().push(assistantMsg);

        broadcastMessage({
          type: "assistant_text_delta",
          text: responseText,
          conversationId,
        });
        emitCannedMessageComplete(
          broadcastMessage,
          conversationId,
          persistedAssistant.id,
        );
        // Same anchor advance as the canned-greeting path above.
        recordConversationPersistedSeq(conversationId, getCurrentSeq());
        publishConversationMessagesChanged(conversationId, originClientId);
      } catch (err) {
        if (assistantMessagePersisted) {
          publishConversationMessagesChanged(conversationId, originClientId);
        }
        log.error({ err, conversationId }, "Clean command failed");
        broadcastMessage({
          type: "conversation_error",
          conversationId,
          code: "UNKNOWN",
          userMessage: `Clean failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      }

      return {
        accepted: true,
        messageId: persisted.id,
        conversationId,
      };
    } finally {
      conversation.setProcessing(false);
      silentlyWithLog(conversation.drainQueue(), "clean-command queue drain");
    }
  }

  const resolvedContent = slashResult.content;

  const requestId = crypto.randomUUID();
  const persistResult = await conversation.persistUserMessage({
    content: resolvedContent,
    attachments,
    requestId,
    metadata: withClientMetadata(
      body.automated === true || body.hidden === true
        ? {
            ...(body.automated === true ? { automated: true } : {}),
            ...(body.hidden === true ? { hidden: true } : {}),
          }
        : undefined,
      clientMetadata,
    ),
    clientMessageId,
  });

  const messageId = persistResult.id;

  if (persistResult.deduplicated) {
    return {
      accepted: true,
      messageId,
      conversationId: mapping.conversationId,
    };
  }

  // A hidden message is suppressed from the UI transcript: don't echo it back
  // to clients (the echo would render a user bubble the list-messages filter
  // otherwise hides). The turn still runs below, and the assistant's reply
  // streams normally — so the chat reads as a proactive greeting.
  if (body.hidden !== true) {
    broadcastMessage({
      type: "user_message_echo",
      text: resolvedContent,
      conversationId: mapping.conversationId,
      messageId,
      requestId,
      clientMessageId,
    });
    // The row this echo announces was durably persisted above, so advance
    // the snapshot↔stream anchor to the echo's seq (stamped inline by
    // `broadcastMessage`). Without this, `/messages` returns the row while
    // still advertising the previous flush's anchor — under-claiming, which
    // breaks the contract that the snapshot reflects all of this
    // conversation's events through the advertised seq. Safe to claim here:
    // the agent loop for this turn hasn't started, so no streamed-but-
    // unflushed content exists for this conversation.
    recordConversationPersistedSeq(mapping.conversationId, getCurrentSeq());
  }
  publishConversationMessagesChanged(mapping.conversationId, originClientId);

  // Fire-and-forget the agent loop; events flow to the hub via broadcastMessage.
  conversation
    .runAgentLoop(resolvedContent, messageId, {
      onEvent: broadcastMessage,
      isInteractive,
      isUserMessage: true,
      ...(body.hidden === true ? { isHiddenPrompt: true } : {}),
    })
    .catch((err) => {
      log.error(
        { err, conversationId: mapping.conversationId },
        "Agent loop failed (POST /messages)",
      );
    });

  return {
    accepted: true,
    messageId,
    conversationId: mapping.conversationId,
  };
}

function escapeXmlContent(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function generateLlmSuggestion(
  provider: Provider,
  assistantText: string,
  priorUserText: string | null,
): Promise<string | null> {
  const log = (await import("../../util/logger.js")).getLogger("runtime-http");
  const truncatedAssistant = escapeXmlContent(
    assistantText.length > 2000 ? assistantText.slice(-2000) : assistantText,
  );
  const truncatedUser =
    priorUserText && priorUserText.length > 500
      ? escapeXmlContent(priorUserText.slice(-500))
      : priorUserText
        ? escapeXmlContent(priorUserText)
        : priorUserText;

  const systemPrompt = [
    "You generate short, casual reply suggestions a user might type next in a chat.",
    "Match the tone and register of the preceding conversation.",
    "",
    "CRITICAL — write from the USER'S perspective only, NEVER from the assistant's:",
    "- The suggestion is what the USER will type into the chat input",
    '- Use first-person "I" only if the user has used it in their prior messages',
    '- NEVER start with phrases like "I can help", "Here\'s what", "Let me", "I\'d suggest" — those are assistant-voice',
    "- Think: if you were the user reading the assistant's reply, what question or follow-up would you ask next?",
    "",
    "Output only the reply text inside the requested tags — no preamble, no commentary.",
  ].join("\n");

  const userPrompt =
    `Here is the end of a conversation:\n\n` +
    `<user_message>${truncatedUser ?? "(no prior user message)"}</user_message>\n` +
    `<assistant_message>${truncatedAssistant}</assistant_message>\n\n` +
    `Write the USER'S next reply — what the user would type. Focus on the LAST question or call-to-action in the assistant message. Keep it short (under 15 words), casual, and in the user's voice. ` +
    `The reply must read as something typed BY the user, not something the assistant would say. Respond in this exact format:\n\n` +
    `<reply>YOUR_REPLY_HERE</reply>`;

  // Single user message only — no assistant-role prefill. Anthropic
  // rejects assistant prefill whenever the request triggers extended
  // thinking (e.g. Opus 4.x at `effort: "xhigh"`), and the call-site
  // config is user-controlled, so we can't statically guarantee a
  // prefill-safe model. Keep `stop_sequences: ["</reply>"]` as an
  // early-termination hint; the parser below handles both tagged and
  // untagged responses so untagged "casual answer" replies still work.
  //
  // Force `thinking: disabled` + `effort: none` so the call works on any
  // user profile — including thinking-enabled profiles (Opus 4.x at
  // `effort: high|xhigh`, etc.) where Anthropic 400s on `temperature` ≠ 1
  // when thinking is enabled or in adaptive mode. A 60-token reply chip
  // doesn't benefit from extended thinking anyway, and burning thinking
  // tokens here would be wasteful.
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
    {
      tools: [],
      // no tools
      systemPrompt,
      config: {
        callSite: "replySuggestion",
        max_tokens: 60,
        stop_sequences: ["</reply>"],
        temperature: 0.7,
        thinking: { type: "disabled" },
        effort: "none",
      },
    },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";
  // Prefer the content inside <reply>…</reply> when the model honors the
  // tag format. If the response has no tags, fall back to the raw text —
  // a plain "Sure, tomorrow works" without tags is still a valid chip.
  const tagMatch = raw.match(/<reply>([\s\S]*?)(?:<\/reply>|$)/i);
  const extracted = tagMatch ? tagMatch[1] : raw;
  const stripped = extracted
    .replace(/<\/?reply>/gi, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (!stripped) {
    log.debug("Suggestion rejected: empty LLM response");
    return null;
  }

  // Take first line only
  const firstLine = stripped.split("\n")[0].trim();
  if (!firstLine) {
    log.debug(
      { rawLength: stripped.length },
      "Suggestion rejected: empty after first-line extraction",
    );
    return null;
  }
  return firstLine;
}

export async function handleGetSuggestion(
  { queryParams }: RouteHandlerArgs,
  deps: {
    suggestionCache: Map<string, string>;
    suggestionInFlight: Map<string, Promise<string | null>>;
  },
): Promise<Record<string, unknown>> {
  const noSuggestion = {
    suggestion: null,
    messageId: null,
    source: "none" as const,
  };

  const conversationKey = queryParams?.conversationKey;
  const conversationId = queryParams?.conversationId;
  if (!conversationKey && !conversationId) {
    throw new BadRequestError(
      "conversationKey or conversationId query parameter is required",
    );
  }

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    if (mapping) {
      resolvedConversationId = mapping.conversationId;
    } else if (getConversation(conversationKey)) {
      resolvedConversationId = conversationKey;
    }
  }
  if (!resolvedConversationId) return noSuggestion;

  const rawMessages = getMessages(resolvedConversationId);
  if (rawMessages.length === 0) return noSuggestion;

  // Staleness check: compare requested messageId against the latest
  // assistant message BEFORE filtering by text content.  This ensures
  // that a newer tool-only assistant turn (empty text) still causes
  // older messageId requests to be correctly marked as stale.
  const requestedMessageId = queryParams?.messageId;
  if (requestedMessageId) {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === "assistant") {
        if (rawMessages[i].id !== requestedMessageId) {
          return { ...noSuggestion, stale: true };
        }
        break;
      }
    }
  }

  const { suggestionCache, suggestionInFlight } = deps;
  const log = (await import("../../util/logger.js")).getLogger("runtime-http");

  // Walk backwards to find the last assistant message with text content
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role !== "assistant") continue;

    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) continue;

    // If a messageId was requested and the first text-bearing assistant
    // message is a *different* message, the request is stale.
    if (requestedMessageId && msg.id !== requestedMessageId) {
      return { ...noSuggestion, stale: true };
    }

    // Return cached suggestion if we already generated one for this message
    const cached = suggestionCache.get(msg.id);
    if (cached !== undefined) {
      return { suggestion: cached, messageId: msg.id, source: "llm" as const };
    }

    // Find the most recent user message preceding this assistant turn so the
    // suggestion model can see both sides of the conversation and doesn't have
    // to guess which role it's generating for.
    let priorUserText: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (rawMessages[j].role !== "user") continue;
      let userContent: unknown;
      try {
        userContent = JSON.parse(rawMessages[j].content);
      } catch {
        userContent = rawMessages[j].content;
      }
      const userText = renderHistoryContent(userContent).text.trim();
      if (userText) {
        priorUserText = userText;
        break;
      }
    }

    // Try LLM suggestion using the configured provider
    const provider = await getConfiguredProvider("replySuggestion");
    if (provider) {
      try {
        // Deduplicate concurrent requests
        let promise = suggestionInFlight.get(msg.id);
        if (!promise) {
          promise = generateLlmSuggestion(provider, text, priorUserText);
          suggestionInFlight.set(msg.id, promise);
        }

        const llmSuggestion = await promise;
        suggestionInFlight.delete(msg.id);

        if (llmSuggestion) {
          // Evict oldest entries if cache is at capacity
          if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
            const oldest = suggestionCache.keys().next().value!;
            suggestionCache.delete(oldest);
          }
          suggestionCache.set(msg.id, llmSuggestion);

          return {
            suggestion: llmSuggestion,
            messageId: msg.id,
            source: "llm" as const,
          };
        }
      } catch (err) {
        suggestionInFlight.delete(msg.id);
        log.warn(
          { err, conversationKey, messageId: msg.id },
          "LLM suggestion failed",
        );
      }
    } else {
      log.debug(
        { conversationKey, messageId: msg.id },
        "Suggestion skipped: no provider available",
      );
    }

    return noSuggestion;
  }

  return noSuggestion;
}

/**
 * GET /search?q=<query>[&limit=<n>][&maxMessagesPerConversation=<n>]
 *
 * Full-text search across all conversations (message content + titles).
 * Returns ranked results grouped by conversation, each with matching message excerpts.
 */
async function handleSearchConversations({
  queryParams,
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const query = queryParams?.q ?? "";
  if (!query.trim()) {
    throw new BadRequestError("q query parameter is required");
  }

  const limit = queryParams?.limit ? Number(queryParams.limit) : undefined;
  const maxMessagesPerConversation = queryParams?.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;

  const results = await searchConversations(query, {
    ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
    ...(maxMessagesPerConversation !== undefined &&
    !isNaN(maxMessagesPerConversation)
      ? { maxMessagesPerConversation }
      : {}),
  });

  return { query, results };
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the standard channel metadata object for message persistence.
 *
 * Combines provenance (trust context), channel/interface routing, and
 * optional per-message fields (automated flag, image source paths) into the
 * Record that `addMessage` stores in the `metadata` column.
 */
function buildChannelMetadata(
  sourceChannel: string,
  sourceInterface: string,
  opts?: {
    trustContext?: Parameters<typeof provenanceFromTrustContext>[0];
    provenanceOverride?: Record<string, unknown>;
    automated?: boolean;
    attachments?: ReadonlyArray<{
      filename: string;
      mimeType: string;
      filePath?: string;
    }>;
  },
): Record<string, unknown> {
  const provenance =
    opts?.provenanceOverride ?? provenanceFromTrustContext(opts?.trustContext);
  const imageSourcePaths = opts?.attachments
    ? extractImageSourcePaths(opts.attachments)
    : undefined;
  return {
    ...provenance,
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
    userMessageInterface: sourceInterface,
    assistantMessageInterface: sourceInterface,
    ...(opts?.automated ? { automated: true } : {}),
    ...(imageSourcePaths ? { imageSourcePaths } : {}),
  };
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const suggestionCache = new Map<string, string>();
const suggestionInFlight = new Map<string, Promise<string | null>>();

function resolveAttachments(attachmentIds: string[]) {
  const resolved = getAttachmentsByIds(attachmentIds, {
    hydrateFileData: true,
  });
  const sourcePaths = getSourcePathsForAttachments(attachmentIds);
  return resolved.map((a) => ({
    id: a.id,
    filename: a.originalFilename,
    mimeType: a.mimeType,
    data: a.dataBase64,
    ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "messages_get",
    endpoint: "messages",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List messages",
    description:
      "Return messages for a conversation, including attachments and interface file metadata.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        type: "string",
        required: false,
        description:
          "Conversation UUID. One of conversationId or conversationKey is required.",
      },
      {
        name: "conversationKey",
        type: "string",
        required: false,
        description:
          "Channel/external conversation key. One of conversationId or conversationKey is required.",
      },
      {
        name: "page",
        type: "string",
        required: false,
        description:
          "When set to 'latest', returns the most recent page of messages with pagination metadata.",
      },
      {
        name: "beforeTimestamp",
        type: "integer",
        required: false,
        description:
          "Return messages older than this timestamp (ms since epoch). Used for paging older history.",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Maximum number of messages to return.",
      },
    ],
    responseBody: z.object({
      messages: z
        .array(ConversationMessageSchema)
        .describe("Array of message objects"),
      hasMore: z
        .boolean()
        .optional()
        .describe("Whether older messages exist beyond this page"),
      oldestTimestamp: z
        .number()
        .nullable()
        .optional()
        .describe(
          "Timestamp of the oldest message in this page (ms since epoch). Null when page=latest is used on an empty conversation.",
        ),
      oldestMessageId: z
        .string()
        .nullable()
        .optional()
        .describe("ID of the oldest message in this page"),
      seq: z
        .number()
        .nullable()
        .optional()
        .describe(
          "Global SSE `seq` of the last event whose content is durably persisted for this conversation in the current daemon process. A client can align this snapshot with the `/events` stream by applying only events with `seq` greater than this value. Null when no events have been persisted in this process (cold conversation, after a daemon restart, or when the conversation has aged out of the in-memory map) — clients should cold-start in that case. Absent on older daemons that predate this field.",
        ),
      processing: z
        .boolean()
        .optional()
        .describe(
          "Whether the agent is currently mid-turn for this conversation, sourced authoritatively from the persisted `processing_started_at` column. `true` means a turn is in flight; `false` means the conversation is idle. Clients use this to recover from a dropped SSE stream: if a turn appears to be running locally but the server reports `processing: false`, the turn has ended (or died) and the UI should stop waiting rather than spin indefinitely. Absent on older daemons that predate this field.",
        ),
    }),
    handler: (args) => handleListMessages(args),
  },
  {
    operationId: "messages_post",
    endpoint: "messages",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Send a message",
    description:
      "Send a user message to a conversation and trigger the assistant response.",
    tags: ["messages"],
    responseStatus: "202",
    requestBody: z.object({
      conversationId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Internal conversation id (0.8.6+ strict lookup). Omit both id and key to mint a new conversation server-side.",
        ),
      conversationKey: z.string().nullable().optional(),
      content: z.string().describe("Message text content"),
      attachments: z
        .array(z.unknown())
        .describe("Optional inline file attachments")
        .optional(),
      attachmentIds: z
        .array(z.string())
        .describe("Ids of previously uploaded attachments to attach")
        .optional(),
      sourceChannel: z
        .string()
        .describe('Originating channel id (e.g. "vellum")'),
      interface: z
        .string()
        .describe('Originating interface id (e.g. "vellum")'),
      conversationType: z.string().optional(),
      slashCommand: z.string().optional(),
      clientTimezone: z.string().optional(),
      clientOs: z
        .string()
        .optional()
        .describe(
          'Client OS surface ("web" | "ios" | "macos" | "android"), reported separately from `interface`. Drives the per-turn `client_os` context only; does not affect transport/host-proxy capabilities.',
        ),
      clientMessageId: z
        .string()
        .describe(
          "Client-generated idempotency nonce. Persisted on the row and echoed back on the message_echo event and the messages snapshot so the client can correlate its optimistic row by identity. Duplicate sends for the same (conversation, clientMessageId) are deduplicated server-side.",
        )
        .optional(),
      inferenceProfile: z.string().nullable().optional(),
      enabledPlugins: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Plugin ids that scope this conversation to a subset of installed plugins (first-party defaults are always available). When present on a message, it sets/updates the conversation's plugin scope (the web client sends it only on the first message of a new chat). null clears the scope to default (all enabled plugins); omitting the field leaves the existing scope unchanged.",
        ),
      riskThreshold: z.enum(VALID_RISK_THRESHOLDS).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe(
          "When true, persist the user message but suppress it from the UI transcript (it stays in LLM-side history and still drives the turn). Used for machine signals the user never typed (proactive-greeting priming, channel-setup wizard close). Suppression covers the queued path too: a hidden send that lands mid-turn returns { queued: true, requestId } but never appears in list-messages queued snapshots, emits no echo, and does not supersede pending interactions. Honored on the standard send path only — slash-command content bypasses it.",
        ),
      onboarding: z
        .object({
          tools: z.array(z.string()),
          tasks: z.array(z.string()),
          tone: z.string(),
          userName: z.string().optional(),
          occupation: z.string().optional(),
          assistantName: z.string().optional(),
          googleConnected: z.boolean().optional(),
          googleScopes: z.array(z.string()).optional(),
          priorAssistants: z.array(z.string()).optional(),
          cohort: z.string().optional(),
          websiteUrl: z.string().optional(),
          contentSourceUrl: z.string().optional(),
          bootstrapTemplate: z.string().optional(),
          initialMessage: z.string().optional(),
          skills: z.array(z.string()).optional(),
          title: z
            .string()
            .optional()
            .describe(
              "Explicit title for the conversation minted on this first message. Persisted as a user-set title (never overwritten by the auto-titler). Used by onboarding flows that mint a conversation behind the scenes.",
            ),
        })
        .describe("PreChat onboarding context, sent on the first message only")
        .optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
      conversationId: z.string().optional(),
      messageId: z.string().optional(),
      queued: z.boolean().optional(),
      requestId: z.string().optional(),
    }),
    handler: async (args) =>
      handleSendMessage(args, {
        sendMessageDeps: {
          getOrCreateConversation: getOrCreateConversationInstance,
          assistantEventHub,
          resolveAttachments,
        },
        approvalConversationGenerator: createApprovalConversationGenerator(),
      }),
  },
  {
    operationId: "search_get",
    endpoint: "search",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search conversations",
    description: "Full-text search across all conversations.",
    tags: ["conversations"],
    responseBody: z.object({
      query: z.string(),
      results: z.array(z.unknown()),
    }),
    handler: handleSearchConversations,
  },
  {
    operationId: "suggestion_get",
    endpoint: "suggestion",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get reply suggestion",
    description:
      "Return an LLM-generated follow-up suggestion for the most recent assistant message.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        type: "string",
        description:
          "Conversation ID to fetch a suggestion for. Either this or conversationKey is required.",
      },
      {
        name: "conversationKey",
        type: "string",
        description:
          "Legacy conversation key. Either this or conversationId is required.",
      },
      {
        name: "messageId",
        type: "string",
        description:
          "Optional. Latest assistant message ID the client has seen — used to detect staleness.",
      },
    ],
    responseBody: z.object({
      suggestion: z.string().nullable(),
      messageId: z.string().nullable(),
      source: z.string(),
      stale: z.boolean().optional(),
    }),
    handler: async (args) =>
      handleGetSuggestion(args, {
        suggestionCache,
        suggestionInFlight,
      }),
  },
];
