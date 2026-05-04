/**
 * Route handlers for conversation messages and suggestions.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { z } from "zod";

import { enrichMessageWithSourcePaths } from "../../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../../agent/message-types.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isInteractiveInterface,
  parseChannelId,
  parseInterfaceId,
  supportsHostProxy,
} from "../../channels/types.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import { getConfig } from "../../config/loader.js";
import { createApprovalConversationGenerator } from "../../daemon/approval-generators.js";
import type { Conversation } from "../../daemon/conversation.js";
import {
  buildModelInfoEvent,
  formatCompactResult,
  isModelSlashCommand,
} from "../../daemon/conversation-process.js";
import {
  buildSlashContextForContent,
  resolveSlash,
} from "../../daemon/conversation-slash.js";
import { getOrCreateConversation as getOrCreateConversationInstance } from "../../daemon/conversation-store.js";
import {
  getCannedFirstGreeting,
  isWakeUpGreeting,
} from "../../daemon/first-greeting.js";
import { renderHistoryContent } from "../../daemon/handlers/shared.js";
import { HostAppControlProxy } from "../../daemon/host-app-control-proxy.js";
import { HostCuProxy } from "../../daemon/host-cu-proxy.js";
import { preactivateHostProxySkills } from "../../daemon/host-proxy-preactivation.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type {
  HostProxyTransportMetadata,
  NonHostProxyTransportMetadata,
} from "../../daemon/message-types/conversations.js";
import { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import {
  writeOnboardingSidecar,
  writeRelationshipState,
} from "../../home/relationship-state-writer.js";
import { ipcCall } from "../../ipc/gateway-client.js";
import {
  getAttachmentById,
  getAttachmentMetadataForMessage,
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../../memory/attachments-store.js";
import {
  listCanonicalGuardianRequests,
  listPendingRequestsByConversationScope,
  resolveCanonicalGuardianRequest,
} from "../../memory/canonical-guardian-store.js";
import {
  addMessage,
  getLastAssistantTimestampBefore,
  getMessages,
  getMessagesPaginated,
  hasMessages,
  type MessageRow,
  provenanceFromTrustContext,
  setConversationInferenceProfile,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../../memory/conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
} from "../../memory/conversation-key-store.js";
import { searchConversations } from "../../memory/conversation-queries.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { getLogger } from "../../util/logger.js";
import {
  getInterfacesDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";
import { silentlyWithLog } from "../../util/silently.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub, broadcastMessage } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { routeGuardianReply } from "../guardian-reply-router.js";
import { healGuardianBindingDrift } from "../guardian-vellum-migration.js";
import type {
  ApprovalConversationGenerator,
  RuntimeAttachmentMetadata,
  RuntimeMessagePayload,
  SendMessageDeps,
} from "../http-types.js";
import { resolveLocalTrustContext } from "../local-actor-identity.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  resolveTrustContext,
  withSourceChannel,
} from "../trust-context-resolver.js";
import { BadRequestError, InternalError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";

const log = getLogger("conversation-routes");

/** Matches the `<no_response/>` sentinel used by channel delivery suppression. */
const NO_RESPONSE_INLINE_RE = /<no_response\s*\/?>/g;

const SUGGESTION_CACHE_MAX = 100;
const VALID_RISK_THRESHOLDS = ["none", "low", "medium", "high"] as const;
type RiskThreshold = (typeof VALID_RISK_THRESHOLDS)[number];

function isValidRiskThreshold(value: unknown): value is RiskThreshold {
  return (
    typeof value === "string" &&
    VALID_RISK_THRESHOLDS.includes(value as RiskThreshold)
  );
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
  // Always pass the hints array (even when empty) so
  // findPendingCanonicalRequests respects the in-memory staleness filter
  // applied by collectCanonicalGuardianRequestHintIds. Converting empty
  // hints to `undefined` caused the router to fall through to raw DB
  // queries that rediscovered stale canonical requests.
  const pendingRequestIds = pendingRequestHintIds;

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
    pendingRequestIds,
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
    const guardianImageSourcePaths: Record<string, string> = {};
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
        guardianImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
      }
    }
    const channelMeta = {
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
      userMessageInterface: sourceInterface,
      assistantMessageInterface: sourceInterface,
      provenanceTrustClass: "guardian" as const,
      ...(Object.keys(guardianImageSourcePaths).length > 0
        ? { imageSourcePaths: guardianImageSourcePaths }
        : {}),
    };

    const cleanUserMessage = createUserMessage(content, attachments);
    const llmUserMessage = enrichMessageWithSourcePaths(
      cleanUserMessage,
      attachments,
    );
    const persistedUser = await addMessage(
      conversationId,
      "user",
      JSON.stringify(cleanUserMessage.content),
      channelMeta,
    );
    messageId = persistedUser.id;

    const replyText =
      routerResult.replyText?.trim() ||
      (routerResult.decisionApplied
        ? "Decision applied."
        : "Request already resolved.");
    const assistantMessage = createAssistantMessage(replyText);
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMessage.content),
      channelMeta,
    );

    // Avoid mutating in-memory history / emitting stream deltas while a run is active.
    if (!conversation.isProcessing()) {
      conversation.getMessages().push(llmUserMessage, assistantMessage);
      onEvent({
        type: "assistant_text_delta",
        text: replyText,
        conversationId: conversationId,
      });
      onEvent({ type: "message_complete", conversationId: conversationId });
    }
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist inline approval transcript entries",
    );
  }

  return { consumed: true, messageId };
}

function getInterfaceFilesWithMtimes(
  interfacesDir: string | null,
): Array<{ path: string; mtimeMs: number }> {
  if (!interfacesDir || !existsSync(interfacesDir)) return [];
  const results: Array<{ path: string; mtimeMs: number }> = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        results.push({
          path: relative(interfacesDir, fullPath),
          mtimeMs: statSync(fullPath).mtimeMs,
        });
      }
    }
  };
  scan(interfacesDir);
  return results;
}

export function handleListMessages(
  { queryParams }: RouteHandlerArgs,
  interfacesDir: string | null,
): Record<string, unknown> {
  const conversationId = queryParams?.conversationId;
  const conversationKey = queryParams?.conversationKey;

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
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

  if (isPaginated) {
    const result = getMessagesPaginated(
      resolvedConversationId,
      limit,
      beforeTimestamp,
    );
    rawMessages = result.messages;
    hasMore = result.hasMore;
  } else {
    rawMessages = getMessages(resolvedConversationId);
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

  // Parse content blocks and extract text + tool calls
  const parsed = consolidatedMessages.map((msg) => {
    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);

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
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata);
        if (typeof meta.sentAt === "number") sentAt = meta.sentAt;
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
            };
          }
        }
      } catch {
        // Ignore malformed metadata
      }
    }

    // Strip <no_response/> markers from assistant messages so web/API
    // clients never see the raw sentinel. Only assistant messages produce
    // this marker; user messages are left untouched.
    if (msg.role === "assistant") {
      const originalSegments = rendered.textSegments;
      const keepIndices: number[] = [];
      const filteredSegments: string[] = [];
      for (let i = 0; i < originalSegments.length; i++) {
        const cleaned = originalSegments[i]
          .replace(NO_RESPONSE_INLINE_RE, "")
          .trim();
        if (cleaned.length > 0) {
          keepIndices.push(i);
          filteredSegments.push(cleaned);
        }
      }
      // Remap contentOrder text:N indices to account for removed segments
      const indexMap = new Map<number, number>();
      keepIndices.forEach((oldIdx, newIdx) => indexMap.set(oldIdx, newIdx));
      const filteredContentOrder = rendered.contentOrder
        .map((entry) => {
          const m = entry.match(/^text:(\d+)$/);
          if (!m) return entry;
          const newIdx = indexMap.get(Number(m[1]));
          return newIdx !== undefined ? `text:${newIdx}` : undefined;
        })
        .filter((e): e is string => e !== undefined);

      return {
        role: msg.role,
        text: rendered.text.replace(NO_RESPONSE_INLINE_RE, "").trim(),
        timestamp: msg.createdAt,
        sentAt,
        toolCalls: rendered.toolCalls,
        toolCallsBeforeText: rendered.toolCallsBeforeText,
        textSegments: filteredSegments,
        contentOrder: filteredContentOrder,
        surfaces: rendered.surfaces,
        ...(rendered.thinkingSegments.length > 0
          ? { thinkingSegments: rendered.thinkingSegments }
          : {}),
        id: msg.id,
        subagentNotification,
      };
    }

    return {
      role: msg.role,
      text: rendered.text,
      timestamp: msg.createdAt,
      sentAt,
      toolCalls: rendered.toolCalls,
      toolCallsBeforeText: rendered.toolCallsBeforeText,
      textSegments: rendered.textSegments,
      contentOrder: rendered.contentOrder,
      surfaces: rendered.surfaces,
      ...(rendered.thinkingSegments.length > 0
        ? { thinkingSegments: rendered.thinkingSegments }
        : {}),
      id: msg.id,
      subagentNotification,
    };
  });

  const interfaceFiles = getInterfaceFilesWithMtimes(interfacesDir);

  let prevAssistantTimestamp = 0;
  if (isPaginated && rawMessages.length > 0) {
    prevAssistantTimestamp = getLastAssistantTimestampBefore(
      resolvedConversationId!,
      rawMessages[0].createdAt,
    );
  }
  const messages: RuntimeMessagePayload[] = parsed.map((m) => {
    let msgAttachments: RuntimeAttachmentMetadata[] = [];
    if (m.id) {
      // Use metadata-only query first to avoid loading large base64
      // blobs for non-image attachments (documents, audio). Then
      // selectively fetch full data only for images so the client can
      // generate thumbnails for inline display on history restore.
      // Also query attachments for any messages that were merged into
      // this one (consecutive assistant merge), so their attachments
      // aren't lost before DB compaction relinks them.
      const idsToQuery = [m.id, ...(mergedIdMap.get(m.id) ?? [])];
      const linked = idsToQuery.flatMap((id) =>
        getAttachmentMetadataForMessage(id),
      );
      if (linked.length > 0) {
        msgAttachments = linked.map((a) => {
          if (a.mimeType.startsWith("image/")) {
            const full = getAttachmentById(a.id, {
              hydrateFileData: true,
            });
            return {
              id: a.id,
              filename: a.originalFilename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              kind: a.kind,
              ...(full?.dataBase64 ? { data: full.dataBase64 } : {}),
              ...(a.thumbnailBase64
                ? { thumbnailData: a.thumbnailBase64 }
                : {}),
              fileBacked: true,
            };
          }
          return {
            id: a.id,
            filename: a.originalFilename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            kind: a.kind,
            ...(a.thumbnailBase64 ? { thumbnailData: a.thumbnailBase64 } : {}),
            fileBacked: true,
          };
        });
      }
    }

    let interfaces: string[] | undefined;
    if (m.role === "assistant") {
      const msgTimestamp = new Date(m.timestamp).getTime();
      const dirtied = interfaceFiles
        .filter(
          (f) =>
            f.mtimeMs > prevAssistantTimestamp && f.mtimeMs <= msgTimestamp,
        )
        .map((f) => f.path);
      if (dirtied.length > 0) {
        interfaces = dirtied;
      }
      prevAssistantTimestamp = msgTimestamp;
    }

    // Use sentAt (actual event time) for the display timestamp when
    // available, falling back to createdAt (persistence time).
    // Note: clients use this display timestamp as their pagination cursor
    // after memory-pressure trimming, while server-side pagination filters
    // on createdAt. The mismatch is benign — it may return slightly extra
    // data on a page boundary but never loses messages.
    const displayTimestamp = m.sentAt ?? m.timestamp;
    return {
      id: m.id ?? "",
      role: m.role,
      content: m.text,
      timestamp: new Date(displayTimestamp).toISOString(),
      attachments: msgAttachments,
      ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      ...(interfaces ? { interfaces } : {}),
      ...(m.surfaces.length > 0 ? { surfaces: m.surfaces } : {}),
      ...(m.textSegments.length > 0 ? { textSegments: m.textSegments } : {}),
      ...(m.thinkingSegments?.length
        ? { thinkingSegments: m.thinkingSegments }
        : {}),
      ...(m.contentOrder.length > 0 ? { contentOrder: m.contentOrder } : {}),
      ...(m.subagentNotification
        ? { subagentNotification: m.subagentNotification }
        : {}),
    };
  });

  if (isPaginated) {
    const oldestTimestamp =
      rawMessages.length > 0 ? rawMessages[0].createdAt : undefined;
    const oldestMessageId =
      rawMessages.length > 0 ? rawMessages[0].id : undefined;
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
      };
    }

    return {
      messages,
      hasMore,
      ...(oldestTimestamp != null ? { oldestTimestamp } : {}),
      ...(oldestMessageId != null ? { oldestMessageId } : {}),
    };
  }

  return { messages };
}

// ── Tool-result merging ─────────────────────────────────────────────

function isToolResultType(type: string): boolean {
  return type === "tool_result" || type === "web_search_tool_result";
}

function isSystemNoticeText(block: Record<string, unknown>): boolean {
  if (block.type !== "text") return false;
  const text = typeof block.text === "string" ? block.text : "";
  return (
    text.startsWith("<system_notice>") && text.endsWith("</system_notice>")
  );
}

/**
 * Merge tool_result blocks from user messages into the preceding assistant
 * message's content array. This lets renderHistoryContent's pendingToolUses
 * map pair tool_use and tool_result blocks, preventing "unknown" tool names.
 *
 * User messages that consist entirely of tool_result blocks (and optional
 * system_notice text) are removed from the output. Mixed messages (tool_result
 * + real user text) keep only the non-tool-result blocks.
 */
function mergeToolResultsIntoAssistantMessages(
  messages: MessageRow[],
): MessageRow[] {
  // Index of the most recent assistant message in the output array.
  let lastAssistantIdx = -1;
  // Parsed content caches — lazily populated per assistant message.
  const parsedAssistantContent = new Map<number, unknown[]>();

  const result: MessageRow[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      lastAssistantIdx = result.length;
      result.push(msg);
      continue;
    }

    // Only process user messages — other roles pass through.
    if (msg.role !== "user") {
      result.push(msg);
      continue;
    }

    let blocks: unknown[];
    try {
      const parsed = JSON.parse(msg.content);
      if (!Array.isArray(parsed)) {
        result.push(msg);
        continue;
      }
      blocks = parsed;
    } catch {
      result.push(msg);
      continue;
    }

    // Separate tool-result blocks from real user content.
    const toolResultBlocks: unknown[] = [];
    const otherBlocks: unknown[] = [];
    for (const block of blocks) {
      if (
        typeof block === "object" &&
        block !== null &&
        typeof (block as Record<string, unknown>).type === "string"
      ) {
        const rec = block as Record<string, unknown>;
        if (isToolResultType(rec.type as string)) {
          toolResultBlocks.push(block);
        } else if (isSystemNoticeText(rec)) {
          // System notices don't count as user content — drop them when
          // the message is otherwise tool-result-only.
          otherBlocks.push(block);
        } else {
          otherBlocks.push(block);
        }
      } else {
        otherBlocks.push(block);
      }
    }

    // No tool results → pass through unchanged. System notices are only
    // injected alongside tool results in the agent loop, so a pure user
    // message (no tool_result blocks) should never be filtered — even if
    // the user's text happens to look like a system_notice tag.
    if (toolResultBlocks.length === 0) {
      result.push(msg);
      continue;
    }

    // Append tool_result blocks to the preceding assistant message's content.
    if (lastAssistantIdx >= 0) {
      const assistant = result[lastAssistantIdx];
      let assistantContent = parsedAssistantContent.get(lastAssistantIdx);
      if (!assistantContent) {
        try {
          const parsed = JSON.parse(assistant.content);
          assistantContent = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          assistantContent = [];
        }
        parsedAssistantContent.set(lastAssistantIdx, assistantContent);
      }
      assistantContent.push(...toolResultBlocks);
    } else {
      // No preceding assistant message (pagination boundary) — keep the
      // original message as-is to avoid permanent data loss. The preceding
      // assistant tool_use lives in the previous page; dropping the result
      // here would be unrecoverable.
      // Still strip system notices so internal prompt text isn't exposed.
      const filteredBlocks = blocks.filter(
        (b) =>
          !(
            typeof b === "object" &&
            b !== null &&
            isSystemNoticeText(b as Record<string, unknown>)
          ),
      );
      result.push({
        ...msg,
        content:
          filteredBlocks.length === blocks.length
            ? msg.content
            : JSON.stringify(filteredBlocks),
      });
      continue;
    }

    // If the user message had only tool_result (+ system_notice) blocks,
    // suppress it entirely. Otherwise keep the non-tool-result content.
    const realUserContent = otherBlocks.filter(
      (b) =>
        !(
          typeof b === "object" &&
          b !== null &&
          isSystemNoticeText(b as Record<string, unknown>)
        ),
    );
    if (realUserContent.length > 0) {
      result.push({ ...msg, content: JSON.stringify(otherBlocks) });
    }
    // else: tool-result-only → suppressed (results already merged above)
  }

  // Write back any modified assistant message content.
  for (const [idx, content] of parsedAssistantContent) {
    result[idx] = { ...result[idx], content: JSON.stringify(content) };
  }

  return result;
}

// ── Consecutive assistant message merging ────────────────────────────

/** Parse a message's JSON content into an array of content blocks. */
function parseContentBlocks(content: string): unknown[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    log.warn(
      { err },
      "Failed to parse content blocks during assistant message merge",
    );
    return [];
  }
}

/**
 * Append content blocks from a donor message onto a target block array.
 * Parses the donor's JSON content and pushes each block into `target`.
 */
function appendContentBlocks(target: unknown[], donorContent: string): void {
  try {
    const parsed = JSON.parse(donorContent);
    if (Array.isArray(parsed)) {
      target.push(...parsed);
    } else {
      target.push(parsed);
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to parse donor content blocks during assistant message merge",
    );
  }
}

/**
 * Promote metadata fields from a donor message to the surviving message
 * when the survivor lacks them. Currently promotes `subagentNotification`.
 * Returns a new MessageRow if promotion occurred, otherwise the original.
 */
function promoteMetadata(survivor: MessageRow, donor: MessageRow): MessageRow {
  if (donor.metadata && survivor.metadata) {
    try {
      const survivorMeta = JSON.parse(survivor.metadata);
      const donorMeta = JSON.parse(donor.metadata);
      if (
        !survivorMeta.subagentNotification &&
        donorMeta.subagentNotification
      ) {
        survivorMeta.subagentNotification = donorMeta.subagentNotification;
        return { ...survivor, metadata: JSON.stringify(survivorMeta) };
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to parse metadata during assistant message merge",
      );
    }
  } else if (donor.metadata && !survivor.metadata) {
    return { ...survivor, metadata: donor.metadata };
  }
  return survivor;
}

/**
 * Merge consecutive assistant messages into a single message at query time.
 *
 * During streaming, all assistant turns within one agent loop accumulate on
 * a single client-side ChatMessage. In the DB, each API turn is stored as a
 * separate assistant row (consolidation is deferred to compaction for
 * prefix-cache stability). This produces N separate assistant messages that
 * the client renders as N individual bubbles — each showing "Completed 1
 * step" instead of one grouped "Completed N steps" accordion.
 *
 * This function concatenates the content block arrays of consecutive
 * assistant messages (no intervening user messages after tool-result
 * merging) into the first message of each run. The merged messages are
 * removed from the output. This is query-time only — the DB is not
 * modified.
 *
 * The first message in each run keeps its id, createdAt, and metadata so
 * that attachment lookups, display timestamps, and subagent notifications
 * continue to work. Metadata from later messages in the run (e.g.
 * subagentNotification) is preserved by promoting it to the surviving
 * message when the surviving message has no metadata of its own for that
 * field.
 */
function mergeConsecutiveAssistantMessages(messages: MessageRow[]): {
  messages: MessageRow[];
  /** Maps each surviving message ID → all original message IDs merged into it. */
  mergedIdMap: Map<string, string[]>;
} {
  const result: MessageRow[] = [];
  // Key = index in `result`, value = accumulated content blocks.
  const pendingMerges = new Map<number, unknown[]>();
  // Key = index in `result`, value = IDs of messages merged into the target.
  const mergedIds = new Map<number, string[]>();

  for (const msg of messages) {
    const lastIdx = result.length - 1;
    const isConsecutiveAssistant =
      msg.role === "assistant" &&
      lastIdx >= 0 &&
      result[lastIdx].role === "assistant";

    if (!isConsecutiveAssistant) {
      result.push(msg);
      continue;
    }

    // Track the donor message ID.
    let ids = mergedIds.get(lastIdx);
    if (!ids) {
      ids = [];
      mergedIds.set(lastIdx, ids);
    }
    ids.push(msg.id);

    // Lazily parse the target's content on first merge.
    let targetContent = pendingMerges.get(lastIdx);
    if (!targetContent) {
      targetContent = parseContentBlocks(result[lastIdx].content);
      pendingMerges.set(lastIdx, targetContent);
    }

    appendContentBlocks(targetContent, msg.content);
    result[lastIdx] = promoteMetadata(result[lastIdx], msg);
  }

  // Write back merged content for any messages that were targets.
  for (const [idx, content] of pendingMerges) {
    result[idx] = { ...result[idx], content: JSON.stringify(content) };
  }

  // Build the merged ID map keyed by surviving message ID.
  const mergedIdMap = new Map<string, string[]>();
  for (const [idx, ids] of mergedIds) {
    mergedIdMap.set(result[idx].id, ids);
  }

  return { messages: result, mergedIdMap };
}

/**
 * Persist the pre-chat onboarding payload to disk.
 *
 * Runs only on the very first message of a fresh conversation. Three
 * artifacts are produced:
 *
 *   1. `data/onboarding-context.json` — sidecar read by the
 *      relationship-state writer so onboarding-sourced facts survive
 *      the pure-recomputation write cycle (every turn boundary rebuilds
 *      facts from markdown; the sidecar is the durable source for the
 *      tool/task/tone chips).
 *   2. `IDENTITY.md` / `USER.md` — persona seed files, only written
 *      when missing so we never clobber existing content. These feed
 *      the system prompt and the relationship-state writer's
 *      `parseIdentity` / `parseUserName` helpers after a daemon
 *      restart when the in-memory onboarding context is gone.
 *   3. `data/relationship-state.json` — kicked off fire-and-forget so
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
  assistantName?: string;
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

  const userName = onboarding.userName?.trim();
  if (userName) {
    const userPath = getWorkspacePromptPath("USER.md");
    try {
      if (existsSync(userPath)) {
        const content = readFileSync(userPath, "utf-8");
        const updated = content.replace(
          /^- (?:\*\*)?Name:(?:\*\*)?\s*.*$/m,
          () => `- **Name:** ${userName}`,
        );
        if (updated !== content) {
          writeFileSync(userPath, updated, "utf-8");
        }
      } else {
        writeFileSync(userPath, `# User\n\n- **Name:** ${userName}\n`, "utf-8");
      }
    } catch (err) {
      log.warn({ err, userPath }, "Failed to seed USER.md from onboarding");
    }
  }

  void writeRelationshipState().catch((err) => {
    log.warn(
      { err },
      "Failed to kick off relationship-state write after onboarding",
    );
  });
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
    content?: string;
    attachmentIds?: string[];
    sourceChannel?: string;
    interface?: string;
    conversationType?: string;
    automated?: boolean;
    bypassSecretCheck?: boolean;
    hostHomeDir?: string;
    hostUsername?: string;
    clientId?: string;
    clientMessageId?: string;
    inferenceProfile?: string | null;
    riskThreshold?: string;
    onboarding?: {
      tools: string[];
      tasks: string[];
      tone: string;
      userName?: string;
      assistantName?: string;
    };
  };

  const actorPrincipalId = headers?.["x-vellum-actor-principal-id"];
  const principalType = headers?.["x-vellum-principal-type"];

  const { conversationKey, content, attachmentIds } = body;
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
    const profiles = getConfig().llm.profiles ?? {};
    if (
      !Object.prototype.hasOwnProperty.call(profiles, requestedInferenceProfile)
    ) {
      throw new BadRequestError(
        `Profile "${requestedInferenceProfile}" is not defined in llm.profiles`,
      );
    }
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

  // When conversationKey is omitted, derive a stable default from
  // sourceChannel + sourceInterface so that repeated calls from the same
  // channel/interface pair share a single conversation thread.
  const resolvedConversationKey =
    conversationKey ?? `default:${sourceChannel}:${sourceInterface}`;

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

  // Desktop messages are always from the guardian — reset the heartbeat
  // timer so the next heartbeat is a full interval after this interaction.
  HeartbeatService.getInstance()?.resetTimer();

  const mapping = getOrCreateConversation(resolvedConversationKey, {
    conversationType: "standard",
  });

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
      smDeps.assistantEventHub
        .publish(
          buildAssistantEvent({
            type: "conversation_list_invalidated",
            reason: "created",
          }),
        )
        .catch((err) => {
          log.warn({ err }, "Failed to publish conversation_list_invalidated");
        });
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
      } satisfies HostProxyTransportMetadata)
    : ({
        channelId: sourceChannel,
        interfaceId: sourceInterface,
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

  // Resolve guardian context from the AuthContext's actorPrincipalId.
  // The JWT-verified principal is used as the sender identity through
  // the same trust resolution pipeline that channel ingress uses.
  if (actorPrincipalId) {
    // Dev bypass (HTTP auth disabled): the synthetic "dev-bypass" principal
    // won't match any guardian binding. Resolve from the local guardian
    // binding instead, which produces the correct guardian trust context.
    if (isHttpAuthDisabled() && actorPrincipalId === "dev-bypass") {
      conversation.setTrustContext(resolveLocalTrustContext(sourceChannel));
    } else {
      const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
      let trustCtx = resolveTrustContext({
        assistantId,
        sourceChannel: "vellum",
        conversationExternalId: "local",
        actorExternalId: actorPrincipalId,
      });
      if (trustCtx.trustClass === "unknown") {
        // Attempt to heal guardian binding drift: after a DB reset the
        // guardian binding gets a new vellum-principal-* UUID while the
        // client still holds a valid JWT with the old one. The signing
        // key survives the reset, so the JWT is authentic — just stale.
        const healed = healGuardianBindingDrift(actorPrincipalId);
        if (healed) {
          trustCtx = resolveTrustContext({
            assistantId,
            sourceChannel: "vellum",
            conversationExternalId: "local",
            actorExternalId: actorPrincipalId,
          });
          log.info(
            {
              actorPrincipalId: actorPrincipalId,
              trustClass: trustCtx.trustClass,
            },
            "Trust re-resolved after guardian binding drift heal",
          );
        } else {
          log.warn(
            {
              actorPrincipalId: actorPrincipalId,
              sourceChannel,
              trustClass: trustCtx.trustClass,
              principalType: principalType,
            },
            "JWT-verified actor resolved to unknown trust class — possible guardian binding drift (e.g. DB reset without re-bootstrap)",
          );
        }
      }
      conversation.setTrustContext(withSourceChannel(sourceChannel, trustCtx));
    }
  } else {
    // Service principals (svc_gateway) or tokens without an actor ID
    // get a minimal guardian context so downstream code has something.
    conversation.setTrustContext({ trustClass: "guardian", sourceChannel });
  }

  const isInteractive = isInteractiveInterface(sourceInterface);
  // Bash/File/Transfer singletons are globally available via isAvailable() —
  // no per-conversation gating needed. CU is per-conversation (owns step
  // count, AX tree history, loop detection).
  if (supportsHostProxy(sourceInterface, "host_cu")) {
    if (!conversation.isProcessing() || !conversation.hostCuProxy) {
      conversation.setHostCuProxy(new HostCuProxy());
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostCuProxy(undefined);
  }
  // App-control mirrors CU's per-conversation lifecycle: the proxy owns a
  // singleton lock plus per-session loop tracking. Instantiation is
  // unconditional when the client supports the capability — feature-flag
  // gating lives in the skill-projection layer (which reads the
  // `feature-flag: app-control` declaration in SKILL.md frontmatter), so
  // an attached proxy is harmless when the flag resolves to off.
  if (supportsHostProxy(sourceInterface, "host_app_control")) {
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
    preactivateHostProxySkills(conversation, sourceInterface);
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

  // ── Canned first-greeting fast path ──
  // On a completely fresh workspace, skip LLM inference for the macOS
  // wake-up greeting and return a pre-written response. When onboarding
  // context is present the greeting is personalized using the selections;
  // otherwise a generic greeting is served. Both paths are instant.
  if (isWakeUpGreeting(trimmedContent, conversation.getMessages().length)) {
    const cannedGreeting = getCannedFirstGreeting(body.onboarding ?? undefined);

    conversation.processing = true;
    let cleanupDeferred = false;
    try {
      const provenance = provenanceFromTrustContext(conversation.trustContext);
      const channelMeta = {
        ...provenance,
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
      };

      const rawContent = content ?? "";
      const attachments = hasAttachments
        ? smDeps.resolveAttachments(attachmentIds)
        : [];
      const userMsg = createUserMessage(rawContent, attachments);
      const persisted = await addMessage(
        mapping.conversationId,
        "user",
        JSON.stringify(userMsg.content),
        channelMeta,
      );
      conversation.getMessages().push(userMsg);

      setConversationOriginChannelIfUnset(
        mapping.conversationId,
        sourceChannel,
      );
      setConversationOriginInterfaceIfUnset(
        mapping.conversationId,
        sourceInterface,
      );

      const conversationId = mapping.conversationId;

      const assistantMsg = createAssistantMessage(cannedGreeting);
      await addMessage(
        mapping.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        channelMeta,
      );
      conversation.getMessages().push(assistantMsg);

      const response = {
        accepted: true,
        messageId: persisted.id,
        conversationId,
      };

      if (isFirstOnboarding) {
        persistOnboardingArtifacts(body.onboarding!);
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
        broadcastMessage({ type: "message_complete", conversationId });
        conversation.processing = false;
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
      if (!cleanupDeferred && conversation.processing) {
        conversation.processing = false;
        silentlyWithLog(conversation.drainQueue(), "error-path queue drain");
      }
    }
  }

  if (isFirstOnboarding) {
    persistOnboardingArtifacts(body.onboarding!);
  }

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
      content: content ?? "",
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
    const enqueueResult = conversation.enqueueMessage(
      content ?? "",
      attachments,
      broadcastMessage,
      requestId,
      undefined, // activeSurfaceId
      undefined, // currentPage
      {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
        ...(body.automated === true ? { automated: true } : {}),
      },
      { isInteractive },
      undefined, // displayContent
      transport,
      clientMessageId,
    );
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
    try {
      if (conversation.hasAnyPendingConfirmation()) {
        // Emit authoritative denial state for each pending request.
        // sendToClient (wired to the SSE hub) delivers these to the client.
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
    } catch (err) {
      log.warn(
        { err, conversationId: mapping.conversationId },
        "Post-enqueue auto-deny failed — queued message unaffected",
      );
    }

    return {
      accepted: true,
      queued: true,
      conversationId: mapping.conversationId,
    };
  }

  // Auto-deny pending confirmations for idle conversations. The legacy
  // handleUserMessage called autoDenyPendingConfirmations unconditionally
  // before dispatching, so an idle conversation with lingering confirmations
  // (e.g. the user never responded to a tool-approval prompt) must deny
  // them before starting the new turn.
  if (conversation.hasAnyPendingConfirmation()) {
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

  await conversation.ensureActorScopedHistory();

  // Resolve slash commands before persisting or running the agent loop.
  const rawContent = content ?? "";
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
    conversation.processing = true;
    let cleanupDeferred = false;
    try {
      const provenance = provenanceFromTrustContext(conversation.trustContext);
      const imageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          imageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
      const channelMeta = {
        ...provenance,
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
        ...(body.automated === true ? { automated: true } : {}),
        ...(Object.keys(imageSourcePaths).length > 0
          ? { imageSourcePaths }
          : {}),
      };
      const cleanMsg = createUserMessage(rawContent, attachments);
      const llmMsg = enrichMessageWithSourcePaths(cleanMsg, attachments);
      const persisted = await addMessage(
        mapping.conversationId,
        "user",
        JSON.stringify(cleanMsg.content),
        channelMeta,
      );
      conversation.getMessages().push(llmMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        mapping.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        channelMeta,
      );
      conversation.getMessages().push(assistantMsg);

      setConversationOriginChannelIfUnset(
        mapping.conversationId,
        sourceChannel,
      );
      setConversationOriginInterfaceIfUnset(
        mapping.conversationId,
        sourceInterface,
      );

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
        broadcastMessage({
          type: "message_complete",
          conversationId: conversationId,
        });
        conversation.processing = false;
        silentlyWithLog(conversation.drainQueue(), "slash-command queue drain");
      }, 0);

      cleanupDeferred = true;
      return response;
    } finally {
      // No-op for the slash-command early-return path (handled inside
      // setTimeout above), but still needed for error paths.
      if (!cleanupDeferred && conversation.processing) {
        conversation.processing = false;
        silentlyWithLog(conversation.drainQueue(), "error-path queue drain");
      }
    }
  }

  if (slashResult.kind === "compact") {
    conversation.processing = true;
    const provenance = provenanceFromTrustContext(conversation.trustContext);
    const channelMeta = {
      ...provenance,
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
      userMessageInterface: sourceInterface,
      assistantMessageInterface: sourceInterface,
    };
    const cleanMsg = createUserMessage(rawContent, attachments);
    const persisted = await addMessage(
      mapping.conversationId,
      "user",
      JSON.stringify(cleanMsg.content),
      channelMeta,
    );
    conversation.getMessages().push(cleanMsg);

    const conversationId = mapping.conversationId;

    // Fire-and-forget: return 202 immediately, run compaction async.
    // forceCompact() makes an LLM call that can exceed the client's
    // HTTP timeout on large contexts, causing a false "Failed to send".
    (async () => {
      try {
        broadcastMessage({
          type: "user_message_echo",
          text: rawContent,
          conversationId,
          messageId: persisted.id,
          clientMessageId,
        });
        conversation.emitActivityState(
          "thinking",
          "context_compacting",
          "assistant_turn",
        );
        const result = await conversation.forceCompact();
        const responseText = formatCompactResult(result);

        const assistantMsg = createAssistantMessage(responseText);
        await addMessage(
          conversationId,
          "assistant",
          JSON.stringify(assistantMsg.content),
          channelMeta,
        );
        conversation.getMessages().push(assistantMsg);

        broadcastMessage({
          type: "assistant_text_delta",
          text: responseText,
          conversationId,
        });
        broadcastMessage({ type: "message_complete", conversationId });
      } catch (err) {
        log.error({ err, conversationId }, "Compact command failed");
        broadcastMessage({
          type: "conversation_error",
          conversationId,
          code: "UNKNOWN",
          userMessage: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        });
      } finally {
        conversation.processing = false;
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

  const resolvedContent = slashResult.content;

  const requestId = crypto.randomUUID();
  let messageId: string;
  try {
    messageId = await conversation.persistUserMessage(
      resolvedContent,
      attachments,
      requestId,
      body.automated === true ? { automated: true } : undefined,
    );
  } catch (err) {
    throw err;
  }

  broadcastMessage({
    type: "user_message_echo",
    text: resolvedContent,
    conversationId: mapping.conversationId,
    messageId,
    requestId,
    clientMessageId,
  });

  // Fire-and-forget the agent loop; events flow to the hub via broadcastMessage.
  conversation
    .runAgentLoop(resolvedContent, messageId, broadcastMessage, {
      isInteractive,
      isUserMessage: true,
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

  const systemPrompt =
    "You generate short, casual reply suggestions a user might type next in a chat. Match the tone and register of the preceding conversation. Output only the reply text inside the requested tags — no preamble, no commentary.";

  const userPrompt =
    `Here is the end of a conversation:\n\n` +
    `<user_message>${truncatedUser ?? "(no prior user message)"}</user_message>\n` +
    `<assistant_message>${truncatedAssistant}</assistant_message>\n\n` +
    `Write the user's next reply, focusing on the LAST question or call-to-action in the assistant message. Keep it short (under 15 words), casual, and in the user's voice. Respond in this exact format:\n\n` +
    `<reply>YOUR_REPLY_HERE</reply>`;

  // Single user message only — no assistant-role prefill. Anthropic
  // rejects assistant prefill whenever the request triggers extended
  // thinking (e.g. Opus 4.x at `effort: "xhigh"`), and the call-site
  // config is user-controlled, so we can't statically guarantee a
  // prefill-safe model. Keep `stop_sequences: ["</reply>"]` as an
  // early-termination hint; the parser below handles both tagged and
  // untagged responses so untagged "casual answer" replies still work.
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
    [], // no tools
    systemPrompt,
    {
      config: {
        callSite: "conversationStarters",
        max_tokens: 60,
        stop_sequences: ["</reply>"],
        temperature: 0.7,
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
  if (!conversationKey) {
    throw new BadRequestError("conversationKey query parameter is required");
  }

  const mapping = getConversationByKey(conversationKey);
  if (!mapping) return noSuggestion;

  const rawMessages = getMessages(mapping.conversationId);
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
    const provider = await getConfiguredProvider("conversationStarters");
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
function handleSearchConversations({
  queryParams,
}: RouteHandlerArgs): Record<string, unknown> {
  const query = queryParams?.q ?? "";
  if (!query.trim()) {
    throw new BadRequestError("q query parameter is required");
  }

  const limit = queryParams?.limit ? Number(queryParams.limit) : undefined;
  const maxMessagesPerConversation = queryParams?.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;

  const results = searchConversations(query, {
    ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
    ...(maxMessagesPerConversation !== undefined &&
    !isNaN(maxMessagesPerConversation)
      ? { maxMessagesPerConversation }
      : {}),
  });

  return { query, results };
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
    summary: "List messages",
    description:
      "Return messages for a conversation, including attachments and interface file metadata.",
    tags: ["messages"],
    responseBody: z.object({
      messages: z.array(z.unknown()).describe("Array of message objects"),
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
    }),
    handler: (args) => handleListMessages(args, getInterfacesDir()),
  },
  {
    operationId: "messages_post",
    endpoint: "messages",
    method: "POST",
    summary: "Send a message",
    description:
      "Send a user message to a conversation and trigger the assistant response.",
    tags: ["messages"],
    responseStatus: "202",
    requestBody: z.object({
      conversationKey: z.string().optional(),
      content: z.string().describe("Message text content"),
      attachments: z
        .array(z.unknown())
        .describe("Optional file attachments")
        .optional(),
      conversationType: z.string().optional(),
      slashCommand: z.string().optional(),
      inferenceProfile: z.string().nullable().optional(),
      riskThreshold: z.enum(VALID_RISK_THRESHOLDS).optional(),
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
    summary: "Get reply suggestion",
    description:
      "Return an LLM-generated follow-up suggestion for the most recent assistant message.",
    tags: ["messages"],
    responseBody: z.object({
      suggestion: z.string(),
      messageId: z.string(),
      source: z.string(),
    }),
    handler: async (args) =>
      handleGetSuggestion(args, {
        suggestionCache,
        suggestionInFlight,
      }),
  },
];
