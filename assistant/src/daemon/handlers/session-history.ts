import {
  getAttachmentsForMessage,
  getFilePathForAttachment,
  setAttachmentThumbnail,
} from "../../memory/attachments-store.js";
import { getMessageById } from "../../memory/conversation-crud.js";
import {
  getMessagesPaginated,
  searchConversations,
} from "../../memory/conversation-queries.js";
import { silentlyWithLog } from "../../util/silently.js";
import { truncate } from "../../util/truncate.js";
import type {
  ConversationSearchRequest,
  HistoryRequest,
  MessageContentRequest,
  UserMessageAttachment,
} from "../message-protocol.js";
import { generateVideoThumbnail } from "../video-thumbnail.js";
import {
  type HandlerContext,
  type HistorySurface,
  type HistoryToolCall,
  log,
  type ParsedHistoryMessage,
  renderHistoryContent,
} from "./shared.js";

export function handleHistoryRequest(
  msg: HistoryRequest,
  ctx: HandlerContext,
): void {
  // No limit means return all messages.
  const limit = msg.limit;

  // Resolve include flags: explicit flags override mode, mode provides defaults.
  // Default mode is 'light' when no mode and no include flags are specified.
  const isFullMode = msg.mode === "full";
  const includeAttachments = msg.includeAttachments ?? isFullMode;
  const includeToolImages = msg.includeToolImages ?? isFullMode;
  const includeSurfaceData = msg.includeSurfaceData ?? isFullMode;

  const { messages: dbMessages, hasMore } = getMessagesPaginated(
    msg.sessionId,
    limit,
    msg.beforeTimestamp,
    msg.beforeMessageId,
  );

  const parsed: ParsedHistoryMessage[] = dbMessages.map((m) => {
    let text = "";
    let toolCalls: HistoryToolCall[] = [];
    let toolCallsBeforeText = false;
    let textSegments: string[] = [];
    let contentOrder: string[] = [];
    let surfaces: HistorySurface[] = [];
    try {
      const content = JSON.parse(m.content);
      const rendered = renderHistoryContent(content);
      text = rendered.text;
      toolCalls = rendered.toolCalls;
      toolCallsBeforeText = rendered.toolCallsBeforeText;
      textSegments = rendered.textSegments;
      contentOrder = rendered.contentOrder;
      surfaces = rendered.surfaces;
      if (m.role === "assistant" && toolCalls.length > 0) {
        log.info(
          {
            messageId: m.id,
            toolCallCount: toolCalls.length,
            text: truncate(text, 100, ""),
          },
          "History message with tool calls",
        );
      }
    } catch (err) {
      log.debug(
        { err, messageId: m.id },
        "Failed to parse message content as JSON, using raw text",
      );
      text = m.content;
      textSegments = text ? [text] : [];
      contentOrder = text ? ["text:0"] : [];
      surfaces = [];
    }
    let subagentNotification: ParsedHistoryMessage["subagentNotification"];
    if (m.metadata) {
      try {
        subagentNotification = (
          JSON.parse(m.metadata) as {
            subagentNotification?: ParsedHistoryMessage["subagentNotification"];
          }
        ).subagentNotification;
      } catch (err) {
        log.debug(
          { err, messageId: m.id },
          "Failed to parse message metadata as JSON, ignoring",
        );
      }
    }
    return {
      id: m.id,
      role: m.role,
      text,
      timestamp: m.createdAt,
      toolCalls,
      toolCallsBeforeText,
      textSegments,
      contentOrder,
      surfaces,
      ...(subagentNotification ? { subagentNotification } : {}),
    };
  });

  const historyMessages = parsed.map((m) => {
    let attachments: UserMessageAttachment[] | undefined;
    if (m.role === "assistant" && m.id) {
      const linked = getAttachmentsForMessage(m.id);
      if (linked.length > 0) {
        if (includeAttachments) {
          // Full attachment data: same behavior as before
          const MAX_INLINE_B64_SIZE = 512 * 1024;
          attachments = linked.map((a) => {
            const isFileBacked = !a.dataBase64;
            const omit =
              isFileBacked ||
              (a.mimeType.startsWith("video/") &&
                a.dataBase64.length > MAX_INLINE_B64_SIZE);

            if (
              a.mimeType.startsWith("video/") &&
              !a.thumbnailBase64 &&
              a.dataBase64
            ) {
              const attachmentId = a.id;
              const base64 = a.dataBase64;
              silentlyWithLog(
                generateVideoThumbnail(base64).then((thumb) => {
                  if (thumb) setAttachmentThumbnail(attachmentId, thumb);
                }),
                "video thumbnail generation",
              );
            }

            const fp = getFilePathForAttachment(a.id);
            return {
              id: a.id,
              filename: a.originalFilename,
              mimeType: a.mimeType,
              data: omit ? "" : a.dataBase64,
              ...(omit ? { sizeBytes: a.sizeBytes } : {}),
              ...(a.thumbnailBase64
                ? { thumbnailData: a.thumbnailBase64 }
                : {}),
              ...(fp ? { filePath: fp } : {}),
            };
          });
        } else {
          // Light mode: metadata only, strip base64 data
          attachments = linked.map((a) => {
            const fp = getFilePathForAttachment(a.id);
            return {
              id: a.id,
              filename: a.originalFilename,
              mimeType: a.mimeType,
              data: "",
              sizeBytes: a.sizeBytes,
              ...(a.thumbnailBase64
                ? { thumbnailData: a.thumbnailBase64 }
                : {}),
              ...(fp ? { filePath: fp } : {}),
            };
          });
        }
      }
    }

    // In light mode, strip imageData from tool calls
    const filteredToolCalls =
      m.toolCalls.length > 0
        ? includeToolImages
          ? m.toolCalls
          : m.toolCalls.map((tc) => {
              if (tc.imageData) {
                const { imageData: _, ...rest } = tc;
                return rest;
              }
              return tc;
            })
        : m.toolCalls;

    // In light mode, strip full data from surfaces (keep metadata)
    const filteredSurfaces =
      m.surfaces.length > 0
        ? includeSurfaceData
          ? m.surfaces
          : m.surfaces.map((s) => ({
              surfaceId: s.surfaceId,
              surfaceType: s.surfaceType,
              title: s.title,
              data: {
                ...(s.surfaceType === "dynamic_page"
                  ? {
                      ...(s.data.preview ? { preview: s.data.preview } : {}),
                      ...(s.data.appId ? { appId: s.data.appId } : {}),
                    }
                  : {}),
              } as Record<string, unknown>,
              ...(s.actions ? { actions: s.actions } : {}),
              ...(s.display ? { display: s.display } : {}),
            }))
        : m.surfaces;

    // Apply text truncation when maxTextChars is set
    let wasTruncated = false;
    let textWasTruncated = false;
    let text = m.text;
    if (msg.maxTextChars !== undefined && text.length > msg.maxTextChars) {
      text = text.slice(0, msg.maxTextChars) + " \u2026 [truncated]";
      wasTruncated = true;
      textWasTruncated = true;
    }

    // Apply tool result truncation when maxToolResultChars is set
    const truncatedToolCalls =
      msg.maxToolResultChars !== undefined && filteredToolCalls.length > 0
        ? filteredToolCalls.map((tc) => {
            if (
              tc.result !== undefined &&
              tc.result.length > msg.maxToolResultChars!
            ) {
              wasTruncated = true;
              return {
                ...tc,
                result:
                  tc.result.slice(0, msg.maxToolResultChars!) +
                  " \u2026 [truncated]",
              };
            }
            return tc;
          })
        : filteredToolCalls;

    return {
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      text,
      timestamp: m.timestamp,
      ...(truncatedToolCalls.length > 0
        ? {
            toolCalls: truncatedToolCalls,
            toolCallsBeforeText: m.toolCallsBeforeText,
          }
        : {}),
      ...(attachments ? { attachments } : {}),
      ...(!textWasTruncated && m.textSegments.length > 0
        ? { textSegments: m.textSegments }
        : {}),
      ...(!textWasTruncated && m.contentOrder.length > 0
        ? { contentOrder: m.contentOrder }
        : {}),
      ...(filteredSurfaces.length > 0 ? { surfaces: filteredSurfaces } : {}),
      ...(m.subagentNotification
        ? { subagentNotification: m.subagentNotification }
        : {}),
      ...(wasTruncated ? { wasTruncated: true } : {}),
    };
  });

  const oldestTimestamp =
    historyMessages.length > 0 ? historyMessages[0].timestamp : undefined;
  // Provide the oldest message ID as a tie-breaker cursor so clients can
  // paginate without skipping same-millisecond messages at page boundaries.
  const oldestMessageId =
    historyMessages.length > 0 ? historyMessages[0].id : undefined;

  ctx.send({
    type: "history_response",
    sessionId: msg.sessionId,
    messages: historyMessages,
    hasMore,
    ...(oldestTimestamp !== undefined ? { oldestTimestamp } : {}),
    ...(oldestMessageId ? { oldestMessageId } : {}),
  });

  // Surfaces are now included directly in the history_response message (in the surfaces array),
  // so we no longer emit separate ui_surface_show messages during history loading.
}

// ---------------------------------------------------------------------------
// Shared business logic (transport-agnostic)
// ---------------------------------------------------------------------------

export interface ConversationSearchParams {
  query: string;
  limit?: number;
  maxMessagesPerConversation?: number;
}

/** Search conversations and return results (no transport dependency). */
export function performConversationSearch(params: ConversationSearchParams) {
  return searchConversations(params.query, {
    limit: params.limit,
    maxMessagesPerConversation: params.maxMessagesPerConversation,
  });
}

export interface MessageContentResult {
  sessionId?: string;
  messageId: string;
  text?: string;
  toolCalls?: Array<{
    name: string;
    result?: string;
    input?: Record<string, unknown>;
  }>;
}

/**
 * Get the full content of a single message by ID.
 * Returns null if the message is not found.
 */
export function getMessageContent(
  messageId: string,
  sessionId?: string,
): MessageContentResult | null {
  const dbMessage = getMessageById(messageId, sessionId);
  if (!dbMessage) return null;

  let text: string | undefined;
  let toolCalls:
    | Array<{ name: string; result?: string; input?: Record<string, unknown> }>
    | undefined;

  try {
    const content = JSON.parse(dbMessage.content);
    const rendered = renderHistoryContent(content);
    text = rendered.text || undefined;
    const parsedToolCalls = rendered.toolCalls;

    if (parsedToolCalls.length > 0) {
      toolCalls = parsedToolCalls.map((tc) => ({
        name: tc.name,
        input: tc.input,
        ...(tc.result !== undefined ? { result: tc.result } : {}),
      }));
    }
  } catch {
    // Raw text content (not JSON)
    text = dbMessage.content || undefined;
  }

  return {
    sessionId,
    messageId,
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

// ---------------------------------------------------------------------------
// IPC handlers (delegate to shared logic)
// ---------------------------------------------------------------------------

export function handleConversationSearch(
  msg: ConversationSearchRequest,
  ctx: HandlerContext,
): void {
  const results = performConversationSearch({
    query: msg.query,
    limit: msg.limit,
    maxMessagesPerConversation: msg.maxMessagesPerConversation,
  });
  ctx.send({
    type: "conversation_search_response",
    query: msg.query,
    results,
  });
}

export function handleMessageContentRequest(
  msg: MessageContentRequest,
  ctx: HandlerContext,
): void {
  const result = getMessageContent(msg.messageId, msg.sessionId);
  if (!result) {
    ctx.send({
      type: "error",
      message: `Message ${msg.messageId} not found in session ${msg.sessionId}`,
    });
    return;
  }

  ctx.send({
    type: "message_content_response",
    sessionId: msg.sessionId,
    messageId: msg.messageId,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
  });
}
