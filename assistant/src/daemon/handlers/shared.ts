import { v4 as uuid } from "uuid";

import type {
  ConversationContentBlock,
  ConversationMessageAttachment,
  ConversationMessageSurface,
  ConversationMessageToolCall,
} from "../../api/responses/conversation-message.js";
import { ConfirmationDecisionSchema } from "../../api/responses/conversation-message.js";
import { getConfig } from "../../config/loader.js";
import type { LLMCallSite, Speed } from "../../config/schemas/llm.js";
import { ipcCall as gatewayIpcCall } from "../../ipc/gateway-client.js";
import type { SecretPromptResult } from "../../permissions/secret-prompt-types.js";
import { resolveMediaSourceData } from "../../providers/media-resolve.js";
import { isPlaceholderSentinelText } from "../../providers/placeholder-sentinels.js";
import type { MediaSource } from "../../providers/types.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import type { AuthContext } from "../../runtime/auth/types.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { unwrapExternalContentForDisplay } from "../../security/untrusted-content.js";
import type { CredentialInjectionTemplate } from "../../tools/credentials/policy-types.js";
import { getLogger } from "../../util/logger.js";
import { joinWithSpacing } from "../../util/text-spacing.js";
import { estimateBase64Bytes } from "../assistant-attachments.js";
import { conversationSupportsDynamicUi } from "../channel-ui-capability.js";
import { findConversation } from "../conversation-registry.js";
import type { ConversationTransportMetadata } from "../message-protocol.js";
import type { TrustContext } from "../trust-context-types.js";

const log = getLogger("handlers");

export { log };

/** Debounce window for suppressing file-watcher config reloads after programmatic saves. */
export const CONFIG_RELOAD_DEBOUNCE_MS = 300;

const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

/**
 * A single tool call rendered into a history row. Alias of the canonical
 * wire-contract type so `renderHistoryContent` (the producer) cannot drift
 * from what the messages endpoint serializes.
 */
export type HistoryToolCall = ConversationMessageToolCall;

/**
 * A UI surface (widget) embedded in a history row. Alias of the canonical
 * wire-contract type so the producer matches the serialized shape.
 */
export type HistorySurface = ConversationMessageSurface;

/**
 * Positional reference to a file attachment captured while walking the
 * content array. The index of an entry in `RenderedHistoryContent.attachments`
 * is what `contentOrder` references as `attachment:N`.
 */
export interface HistoryAttachmentRef {
  /** Stable DB attachment id when persisted on the file block (`_attachmentId`). */
  attachmentId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RenderedHistoryContent {
  text: string;
  toolCalls: HistoryToolCall[];
  /** True when the first tool_use block appeared before any text block. */
  toolCallsBeforeText: boolean;
  /** Text segments split by tool-call boundaries. */
  textSegments: string[];
  /** Content block ordering using "text:N", "tool:N", "surface:N", "attachment:N" encoding. */
  contentOrder: string[];
  /** UI surfaces (widgets) embedded in the message. */
  surfaces: HistorySurface[];
  /** Thinking segments extracted from thinking blocks. */
  thinkingSegments: string[];
  /**
   * File attachments captured in content order. Index `N` matches an
   * `attachment:N` entry in `contentOrder`. Callers align their DB-sourced
   * attachment metadata to this ordering for inline placement.
   */
  attachments: HistoryAttachmentRef[];
  /**
   * Unified ordered content blocks built directly from the model-native
   * content during the single walk — the wire `contentBlocks` projection.
   * `attachment` blocks are inlined for file blocks whose DB-hydrated metadata
   * the caller supplies via the `attachmentBlocks` argument (matched by
   * attachment-ref order); a file block with no supplied metadata produces no
   * block. Every other block type is always complete, so the serializer ships
   * this array as-is with no post-processing.
   */
  contentBlocks: ConversationContentBlock[];
}

/**
 * Slack-specific metadata extracted at the inbound HTTP boundary and threaded
 * through to user-message persistence so the row can be tagged with a
 * `slackMeta` envelope for the chronological renderer.
 */
export interface SlackInboundMessageMetadata {
  /** Slack channel id (conversation external id) — recorded as `channelId`. */
  channelId: string;
  /** Human-readable Slack channel name, when the gateway supplied it. */
  channelName?: string;
  /** Slack `ts` for this message — required so persistence can record `channelTs`. */
  channelTs: string;
  /** Parent `thread_ts` when the message lives inside a thread; absent for top-level. */
  threadTs?: string;
  /** Resolved sender label (display name preferred, username fallback). */
  displayName?: string;
  /** Canonical Slack external user id for the sender, when available. */
  actorExternalUserId?: string;
  /** Slack team id the sender belongs to — the `recipient_team_id` for channel streaming. */
  actorTeamId?: string;
  /** Raw Slack profile timezone for the sender, when supplied. */
  actorTimezone?: string;
  /** Compact Slack profile timezone label for the sender, when supplied. */
  actorTimezoneLabel?: string;
  /** Raw Slack profile timezone offset in seconds, when supplied. */
  actorTimezoneOffsetSeconds?: number;
  /** Timezone used to render this message's timestamp. */
  timestampTimezone?: string;
  /** Compact label for the rendered timestamp timezone. */
  timestampTimezoneLabel?: string;
  /** Compact timezone label appended to the rendered speaker name. */
  speakerTimezoneLabel?: string;
}

/**
 * Optional overrides for conversation creation (e.g. interview mode).
 */
export interface ConversationCreateOptions {
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  speed?: Speed;
  transport?: ConversationTransportMetadata;
  assistantId?: string;
  trustContext?: TrustContext;
  /**
   * Active task-run scope for this turn. Cleared when omitted so background
   * task permissions do not leak into later turns on a reused conversation.
   */
  taskRunId?: string;
  /** Normalized auth context for the conversation. */
  authContext?: AuthContext;
  /** Whether this turn can block on interactive approval prompts. */
  isInteractive?: boolean;
  /**
   * Persisted user-facing content. When present, storage/UI use this value
   * while the model-facing turn continues to use `content`.
   */
  displayContent?: string;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };

  /**
   * Optional explicit model override (provider/model string) for this
   * conversation's agent loop. Used by the auto-analyze loop to pin the
   * analysis agent to a specific model.
   */
  modelOverride?: string;
  /**
   * Optional LLM call-site identifier threaded through to the per-call
   * provider config. Adapter callers (heartbeat, filing, schedule, etc.)
   * pass their call-site here so the agent loop routes through
   * `resolveCallSiteConfig` instead of the global default.
   */
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc inference-profile override (`llm.profiles` key) applied
   * to every LLM call the turn issues. Background callers with a pinned
   * profile (e.g. schedules) pass it here so the agent loop layers the
   * profile via `SendMessageOptions.config.overrideProfile`.
   */
  overrideProfile?: string;
  /**
   * Slack inbound metadata captured at the channel ingress boundary. When
   * present (and the turn channel resolves to Slack), persistence writes a
   * `slackMeta` sub-object into the message's `metadata` JSON for the
   * chronological renderer to consume.
   */
  slackInbound?: SlackInboundMessageMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kb = sizeBytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

function clampAttachmentText(text: string): string {
  if (text.length <= HISTORY_ATTACHMENT_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, HISTORY_ATTACHMENT_TEXT_LIMIT)}<truncated />`;
}

interface FileBlockMetadata {
  mediaType: string;
  filename: string;
  sizeBytes: number;
}

function extractFileBlockMetadata(
  block: Record<string, unknown>,
): FileBlockMetadata {
  const source = isRecord(block.source) ? block.source : null;
  return {
    mediaType:
      source && typeof source.media_type === "string"
        ? source.media_type
        : "application/octet-stream",
    filename:
      source && typeof source.filename === "string"
        ? source.filename
        : "attachment",
    sizeBytes: estimateBase64Bytes(source),
  };
}

/**
 * Build the positional attachment reference for a `file` content block:
 * filename/mime/size from the block's source plus its attachment id. Reference
 * blocks carry the id on `source.attachmentId`; legacy base64 blocks carry it
 * on the top-level `_attachmentId`.
 */
function fileBlockToAttachmentRef(
  block: Record<string, unknown>,
  meta: FileBlockMetadata,
): HistoryAttachmentRef {
  const ref: HistoryAttachmentRef = {
    filename: meta.filename,
    mimeType: meta.mediaType,
    sizeBytes: meta.sizeBytes,
  };
  const source = isRecord(block.source) ? block.source : null;
  const attachmentId =
    source && typeof source.attachmentId === "string" && source.attachmentId
      ? source.attachmentId
      : typeof block._attachmentId === "string" && block._attachmentId
        ? block._attachmentId
        : null;
  if (attachmentId) {
    ref.attachmentId = attachmentId;
  }
  return ref;
}

/**
 * Collect file-block attachment references in content-walk order without
 * building the full history projection. The serializer aligns its DB-hydrated
 * attachment rows against this ordering, then feeds the resolved metadata back
 * into `renderHistoryContent` so it inlines `attachment` blocks during the walk.
 */
export function collectAttachmentRefs(
  content: unknown,
): HistoryAttachmentRef[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const refs: HistoryAttachmentRef[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "file") {
      continue;
    }
    refs.push(fileBlockToAttachmentRef(block, extractFileBlockMetadata(block)));
  }
  return refs;
}

function renderFileBlockForHistory(
  block: Record<string, unknown>,
  meta: FileBlockMetadata,
): string {
  const summaryParts = [
    `[File attachment] ${meta.filename}`,
    `type=${meta.mediaType}`,
  ];
  if (meta.sizeBytes > 0) {
    summaryParts.push(`size=${formatBytes(meta.sizeBytes)}`);
  }

  const extractedText =
    typeof block.extracted_text === "string" ? block.extracted_text.trim() : "";
  if (!extractedText) {
    return summaryParts.join(", ");
  }
  return `${summaryParts.join(", ")}\nAttachment text: ${clampAttachmentText(
    extractedText,
  )}`;
}

export function renderHistoryContent(
  content: unknown,
  attachmentBlocks?: ReadonlyArray<
    ConversationMessageAttachment | null | undefined
  >,
  messageId?: string,
): RenderedHistoryContent {
  if (!Array.isArray(content)) {
    let text: string;
    if (content == null) {
      text = "";
    } else if (typeof content === "object") {
      text = JSON.stringify(content);
    } else {
      text = unwrapExternalContentForDisplay(String(content));
    }
    return {
      text,
      toolCalls: [],
      toolCallsBeforeText: false,
      textSegments: text ? [text] : [],
      contentOrder: text ? ["text:0"] : [],
      surfaces: [],
      thinkingSegments: [],
      attachments: [],
      contentBlocks: text ? [{ type: "text", text }] : [],
    };
  }

  const textParts: string[] = [];
  const attachmentParts: string[] = [];
  const attachments: HistoryAttachmentRef[] = [];
  const toolCalls: HistoryToolCall[] = [];
  const surfaces: HistorySurface[] = [];
  const thinkingSegments: string[] = [];
  const pendingToolUses = new Map<string, HistoryToolCall>();
  let seenText = false;
  let seenToolUse = false;
  let toolCallsBeforeText = false;

  // Segment tracking: text blocks separated by tool_use boundaries
  const textSegments: string[] = [];
  const contentOrder: string[] = [];
  let currentSegmentParts: string[] = [];
  let hasOpenSegment = false;

  // Unified content blocks built in lockstep with the positional arrays as we
  // walk the model-native content. `attachment` blocks are inlined here when
  // the caller supplied DB-hydrated metadata in `attachmentBlocks`, matched by
  // attachment-ref order; otherwise the file block contributes no block.
  const contentBlocks: ConversationContentBlock[] = [];
  let currentTextBlock: { type: "text"; text: string } | null = null;

  function finalizeSegment(): void {
    if (hasOpenSegment) {
      const joined = joinWithSpacing(currentSegmentParts);
      textSegments[textSegments.length - 1] = joined;
      if (currentTextBlock) {
        currentTextBlock.text = joined;
        currentTextBlock = null;
      }
      currentSegmentParts = [];
      hasOpenSegment = false;
    }
  }

  // Flush the open text segment into its tracked block and stop tracking it,
  // without closing the segment. Used before folding the synthetic attachment
  // description into the trailing segment: it stays in the legacy
  // `textSegments`/`text` body but must not pollute the clean contentBlocks,
  // since `attachment` blocks already carry that metadata.
  function detachTextBlock(): void {
    if (currentTextBlock) {
      currentTextBlock.text = joinWithSpacing(currentSegmentParts);
      currentTextBlock = null;
    }
  }

  // `trackBlock` mirrors the segment into `contentBlocks`. The trailing
  // attachment-description segment (legacy `message.text` for clients without
  // attachment UI) sets it false so it isn't duplicated as a text block —
  // attachments surface as `attachment` blocks instead.
  function ensureSegment(trackBlock = true): void {
    if (!hasOpenSegment) {
      textSegments.push("");
      contentOrder.push(`text:${textSegments.length - 1}`);
      hasOpenSegment = true;
      if (trackBlock) {
        currentTextBlock = { type: "text", text: "" };
        contentBlocks.push(currentTextBlock);
      }
    }
  }

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      continue;
    }

    // Collect ui_surface blocks for inclusion in history
    if (block.type === "ui_surface") {
      finalizeSegment();
      const surface: HistorySurface = {
        surfaceId: typeof block.surfaceId === "string" ? block.surfaceId : "",
        surfaceType:
          typeof block.surfaceType === "string" ? block.surfaceType : "",
        title: typeof block.title === "string" ? block.title : undefined,
        data: isRecord(block.data)
          ? (block.data as Record<string, unknown>)
          : {},
        actions: Array.isArray(block.actions) ? block.actions : undefined,
        display: typeof block.display === "string" ? block.display : undefined,
        persistent: block.persistent === true ? true : undefined,
        completed: block.completed === true ? true : undefined,
        completionSummary:
          typeof block.completionSummary === "string"
            ? block.completionSummary
            : undefined,
        toolCallId:
          typeof block.toolCallId === "string" ? block.toolCallId : undefined,
      };
      surfaces.push(surface);
      contentOrder.push(`surface:${surfaces.length - 1}`);
      contentBlocks.push({ type: "surface", surface });
      continue;
    }

    if (block.type === "thinking" && typeof block.thinking === "string") {
      finalizeSegment();
      thinkingSegments.push(block.thinking);
      contentOrder.push(`thinking:${thinkingSegments.length - 1}`);
      const thinkingBlock: Extract<
        ConversationContentBlock,
        { type: "thinking" }
      > = { type: "thinking", thinking: block.thinking };
      if (typeof block._startedAt === "number") {
        thinkingBlock.startedAt = block._startedAt;
      }
      if (typeof block._completedAt === "number") {
        thinkingBlock.completedAt = block._completedAt;
      }
      contentBlocks.push(thinkingBlock);
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      const displayText = unwrapExternalContentForDisplay(block.text);
      // Skip empty/whitespace-only text blocks. During streaming the client
      // discards empty text deltas (guard !text.isEmpty), so including them
      // here produces a contentOrder that differs from the live streaming
      // path — e.g. empty segments between consecutive tool_use blocks that
      // break tool-call grouping in the UI.
      if (displayText.trim().length === 0) {
        continue;
      }
      // Drop Anthropic provider placeholder sentinels. These are injected
      // into outbound API requests to preserve role alternation and must
      // never be rendered to users. Belt-and-suspenders with the persist-
      // time filter in cleanAssistantContent and migration 222.
      if (isPlaceholderSentinelText(displayText)) {
        continue;
      }
      textParts.push(displayText);
      // A ui_surface card's plain-text fallback (flagged `_surfaceFallback` by
      // the approval-card builder) is represented by the adjacent surface for
      // surface-capable clients. Keep it in the flat `.text` body above (CLI,
      // search, channel replies, non-surface clients) but don't emit it as a
      // text segment or content block, or those clients would render the card
      // AND its fallback text.
      if (block._surfaceFallback === true) {
        continue;
      }
      ensureSegment();
      currentSegmentParts.push(displayText);
      seenText = true;
      continue;
    }
    if (block.type === "file") {
      const meta = extractFileBlockMetadata(block);
      attachmentParts.push(renderFileBlockForHistory(block, meta));
      finalizeSegment();
      attachments.push(fileBlockToAttachmentRef(block, meta));
      const refIndex = attachments.length - 1;
      contentOrder.push(`attachment:${refIndex}`);
      const hydrated = attachmentBlocks?.[refIndex];
      if (hydrated) {
        contentBlocks.push({ type: "attachment", attachment: hydrated });
      }
      continue;
    }
    if (block.type === "image") {
      // Image data is sent as a separate attachment — skip the placeholder
      // text so the client doesn't render both "[Image attachment]" and the
      // actual image thumbnail.
      continue;
    }
    if (block.type === "tool_use") {
      finalizeSegment();
      const name = typeof block.name === "string" ? block.name : "unknown";
      const input = isRecord(block.input)
        ? (block.input as Record<string, unknown>)
        : {};
      const id = typeof block.id === "string" ? block.id : "";
      const entry: HistoryToolCall = { name, input };
      if (id) {
        entry.id = id;
      }
      // Extract persisted timing/confirmation metadata
      if (typeof block._startedAt === "number") {
        entry.startedAt = block._startedAt;
      }
      if (typeof block._previewStartedAt === "number") {
        entry.previewStartedAt = block._previewStartedAt;
      }
      if (typeof block._completedAt === "number") {
        entry.completedAt = block._completedAt;
      }
      const confirmationDecision = ConfirmationDecisionSchema.safeParse(
        block._confirmationDecision,
      );
      if (confirmationDecision.success) {
        entry.confirmationDecision = confirmationDecision.data;
      }
      if (typeof block._confirmationLabel === "string") {
        entry.confirmationLabel = block._confirmationLabel;
      }
      if (typeof block._riskLevel === "string") {
        entry.riskLevel = block._riskLevel;
      }
      if (typeof block._riskReason === "string") {
        entry.riskReason = block._riskReason;
      }
      if (typeof block._matchedTrustRuleId === "string") {
        entry.matchedTrustRuleId = block._matchedTrustRuleId;
      }
      if (typeof block._autoApproved === "boolean") {
        entry.autoApproved = block._autoApproved;
      }
      if (typeof block._approvalMode === "string") {
        entry.approvalMode = block._approvalMode;
      }
      if (typeof block._approvalReason === "string") {
        entry.approvalReason = block._approvalReason;
      }
      if (typeof block._riskThreshold === "string") {
        entry.riskThreshold = block._riskThreshold;
      }
      // Read back the 3 risk-option arrays persisted by
      // `annotatePersistedAssistantMessage`. Validate the array shape only
      // — element shapes are best-effort (we trust our own writer).
      if (Array.isArray(block._riskScopeOptions)) {
        entry.riskScopeOptions =
          block._riskScopeOptions as HistoryToolCall["riskScopeOptions"];
      }
      if (Array.isArray(block._riskAllowlistOptions)) {
        entry.riskAllowlistOptions =
          block._riskAllowlistOptions as HistoryToolCall["riskAllowlistOptions"];
      }
      if (Array.isArray(block._riskDirectoryScopeOptions)) {
        entry.riskDirectoryScopeOptions =
          block._riskDirectoryScopeOptions as HistoryToolCall["riskDirectoryScopeOptions"];
      }
      // Read back tool activity (web_search / web_fetch) persisted by
      // `annotatePersistedAssistantMessage` so the activity card survives a
      // history reopen instead of degrading to the plain result text.
      if (isRecord(block._activityMetadata)) {
        entry.activityMetadata =
          block._activityMetadata as HistoryToolCall["activityMetadata"];
      }
      toolCalls.push(entry);
      if (id) {
        pendingToolUses.set(id, entry);
      }
      contentOrder.push(`tool:${toolCalls.length - 1}`);
      // Same `entry` reference the block carries: a later tool_result pairs its
      // output onto `entry`, so the content block reflects it automatically.
      contentBlocks.push({ type: "tool_use", toolCall: entry });
      if (!seenToolUse) {
        seenToolUse = true;
        if (!seenText) {
          toolCallsBeforeText = true;
        }
      }
      continue;
    }
    if (block.type === "server_tool_use") {
      finalizeSegment();
      const name = typeof block.name === "string" ? block.name : "unknown";
      const input = isRecord(block.input)
        ? (block.input as Record<string, unknown>)
        : {};
      const id = typeof block.id === "string" ? block.id : "";
      const entry: HistoryToolCall = { name, input };
      if (id) {
        entry.id = id;
      }
      // Native server tools (Anthropic web_search) persist their activity on
      // the server_tool_use block, so read it back here too.
      if (isRecord(block._activityMetadata)) {
        entry.activityMetadata =
          block._activityMetadata as HistoryToolCall["activityMetadata"];
      }
      toolCalls.push(entry);
      if (id) {
        pendingToolUses.set(id, entry);
      }
      contentOrder.push(`tool:${toolCalls.length - 1}`);
      contentBlocks.push({ type: "tool_use", toolCall: entry });
      if (!seenToolUse) {
        seenToolUse = true;
        if (!seenText) {
          toolCallsBeforeText = true;
        }
      }
      continue;
    }
    if (block.type === "web_search_tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const isError =
        isRecord(block.content) &&
        (block.content as { type?: string }).type ===
          "web_search_tool_result_error";

      // Format search results into readable text.
      let resultContent = "";
      if (Array.isArray(block.content)) {
        resultContent = (block.content as unknown[])
          .filter(
            (r): r is { type: string; title: string; url: string } =>
              typeof r === "object" &&
              r != null &&
              (r as { type?: string }).type === "web_search_result",
          )
          .map((r) => `${r.title}\n${r.url}`)
          .join("\n\n");
      }

      const matched = toolUseId ? pendingToolUses.get(toolUseId) : null;
      if (matched) {
        matched.result = resultContent;
        matched.isError = isError;
      } else {
        toolCalls.push({
          name: "web_search",
          input: {},
          result: resultContent,
          isError,
        });
      }
      continue;
    }
    if (block.type === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const resultContent =
        typeof block.content === "string" ? block.content : "";
      const isError = block.is_error === true;
      // Extract image data from persisted contentBlocks (e.g. browser_screenshot,
      // image generation). Referenced media (a workspace_ref source) emits its
      // attachment id so clients fetch the bytes by id on render instead of
      // inlining base64 into the history wire; legacy inline base64 sources are
      // resolved and carried as base64. A given image goes to exactly one list.
      const imageDataList: string[] = [];
      const imageAttachmentIds: string[] = [];
      if (Array.isArray(block.contentBlocks)) {
        for (const cb of block.contentBlocks) {
          if (isRecord(cb) && cb.type === "image" && isRecord(cb.source)) {
            const source = cb.source as unknown as MediaSource;
            if (source.type === "workspace_ref" && source.attachmentId) {
              imageAttachmentIds.push(source.attachmentId);
              continue;
            }
            const resolved = resolveMediaSourceData(source);
            if (resolved) imageDataList.push(resolved.data);
          }
        }
      }
      const matched = toolUseId ? pendingToolUses.get(toolUseId) : null;
      if (matched) {
        matched.result = resultContent;
        matched.isError = isError;
        if (imageDataList.length > 0) {
          matched.imageData = imageDataList[0];
          matched.imageDataList = imageDataList;
        }
        if (imageAttachmentIds.length > 0) {
          matched.imageAttachmentIds = imageAttachmentIds;
        }
      }
      // Orphan tool_result with no matching tool_use — drop it. Synthesizing
      // a "name: 'unknown'" phantom entry rendered in chat as "Used unknown"
      // / "Completed 1 step" with no context, with a timestamp later than
      // the assistant's final answer. Most commonly orphans appear when
      // context-window compaction trims the parent tool_use block while
      // leaving the paired tool_result. Losing the orphan's result content
      // is correct: without the parent we can't tell the user what tool ran.
      continue;
    }
  }

  // Include attachment descriptions in textSegments so that clients without
  // separate attachment UI (e.g. iOS) can display them via `message.text`.
  // The macOS client handles this by selecting the *first* non-empty text
  // segment in interleaved content, so trailing attachment segments are safe.
  if (attachmentParts.length > 0) {
    detachTextBlock();
    const attachmentText = attachmentParts.join("\n");
    const prefix = textParts.length > 0 ? "\n" : "";
    ensureSegment(false);
    currentSegmentParts.push(prefix + attachmentText);
  }

  finalizeSegment();

  // Default any tool call the provider left without an `id` to the same
  // positional id the web client historically synthesized, so every wire tool
  // call is self-identifying and snapshot/stream ids line up. `idx` indexes the
  // final `toolCalls` array (the client keys off the same positions); the
  // shared `entry` references mean `contentBlocks` reflect this for free.
  if (messageId !== undefined) {
    toolCalls.forEach((toolCall, idx) => {
      if (toolCall.id === undefined) {
        toolCall.id = `tool-history-${messageId}-${idx}`;
      }
    });
  }

  const text = joinWithSpacing(textParts);
  let rendered: string;
  if (attachmentParts.length === 0) {
    rendered = text;
  } else if (text.trim().length === 0) {
    rendered = attachmentParts.join("\n");
  } else {
    rendered = `${text}\n${attachmentParts.join("\n")}`;
  }

  return {
    text: rendered,
    toolCalls,
    toolCallsBeforeText,
    textSegments,
    contentOrder,
    surfaces,
    thinkingSegments,
    attachments,
    contentBlocks,
  };
}

/** Parameters shared by the standalone secret prompt and its link fallback. */
interface StandaloneSecretParams {
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowedTools?: string[];
  allowedDomains?: string[];
  injectionTemplates?: CredentialInjectionTemplate[];
  conversationId?: string;
}

/**
 * Fallback for channels without secure input: mint a one-time collection link
 * via the gateway (flag-gated there) and return it on the result so the
 * caller can relay it. The credential policy travels on the gateway row
 * (`policyJson`) and is applied together with the value at redemption —
 * nothing is stored or mutated until the recipient submits. When minting is
 * unavailable (flag off, no public ingress URL, gateway unreachable) the
 * plain `unsupported_channel` failure stands.
 */
async function mintCollectionLinkFallback(
  params: StandaloneSecretParams,
): Promise<SecretPromptResult> {
  const policy = {
    usageDescription: params.purpose,
    allowedTools: params.allowedTools,
    allowedDomains: params.allowedDomains,
    injectionTemplates: params.injectionTemplates,
  };
  const hasPolicy = Object.values(policy).some((v) => v !== undefined);

  const result = (await gatewayIpcCall("create_credential_request", {
    service: params.service,
    field: params.field,
    label: params.label,
    ...(hasPolicy ? { policyJson: JSON.stringify(policy) } : {}),
  })) as
    | { ok: true; url: string; expiresAt: number }
    | { ok: false; error: string }
    | undefined;

  if (result?.ok) {
    log.info(
      { service: params.service, field: params.field },
      "Secret prompt unsupported on channel — minted a one-time collection link",
    );
    return {
      value: null,
      delivery: "store",
      error: "unsupported_channel",
      collectionUrl: result.url,
      collectionExpiresAt: result.expiresAt,
    };
  }
  return { value: null, delivery: "store", error: "unsupported_channel" };
}

/**
 * Send a `secret_request` to the client and wait for the response, outside of a
 * conversation context (e.g. from IPC routes like credentials/prompt).
 *
 * Lifecycle state (resolver, timer) is registered in pendingInteractions — the
 * same tracker the in-conversation SecretPrompter uses — so `POST /v1/secret`
 * resolves the prompt generically. When a `conversationId` is supplied (the CLI
 * `credentials prompt` command forwards `__CONVERSATION_ID`), the broadcast is
 * scoped to that conversation so clients deliver it; otherwise it is
 * conversation-less. When that conversation's channel cannot render dynamic UI
 * (e.g. slack, telegram), resolves immediately with `unsupported_channel` —
 * carrying a one-time collection link when the gateway can mint one — instead
 * of broadcasting a request that can only time out.
 */
export function requestSecretStandalone(
  params: StandaloneSecretParams,
): Promise<SecretPromptResult> {
  const conversation = findConversation(params.conversationId);
  if (conversation && !conversationSupportsDynamicUi(conversation)) {
    return mintCollectionLinkFallback(params);
  }
  const requestId = uuid();
  const config = getConfig();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingInteractions.resolve(requestId, "cancelled");
      resolve({ value: null, delivery: "store", reason: "timed_out" });
    }, config.timeouts.permissionTimeoutSec * 1000);
    pendingInteractions.register(requestId, {
      conversationId: params.conversationId,
      kind: "secret",
      rpcResolve: resolve as (value: unknown) => void,
      timer,
    });
    broadcastMessage({
      type: "secret_request",
      requestId,
      service: params.service,
      field: params.field,
      label: params.label,
      description: params.description,
      placeholder: params.placeholder,
      conversationId: params.conversationId,
      purpose: params.purpose,
      allowedTools: params.allowedTools,
      allowedDomains: params.allowedDomains,
      allowOneTimeSend: config.secretDetection.allowOneTimeSend,
    });
  });
}

/** Get or create the skill entry object for a given skill name, creating intermediate objects as needed.
 *  Guards against malformed config (e.g. skills or entries being a string, array, or null)
 *  by resetting non-object intermediates to {}, restoring self-healing behavior. */
export function ensureSkillEntry(
  raw: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  if (!isRecord(raw.skills) || Array.isArray(raw.skills)) {
    raw.skills = {};
  }
  const skills = raw.skills as Record<string, unknown>;
  if (!isRecord(skills.entries) || Array.isArray(skills.entries)) {
    skills.entries = {};
  }
  const entries = skills.entries as Record<string, unknown>;
  if (!isRecord(entries[name]) || Array.isArray(entries[name])) {
    entries[name] = {};
  }
  return entries[name] as Record<string, unknown>;
}

/**
 * Parse a version string into its core numeric parts and optional pre-release tag.
 * Handles optional `v`/`V` prefix (e.g. "v0.6.0-staging.5").
 */
function parseSemverParts(v: string): {
  nums: [number, number, number];
  pre: string | null;
} {
  const stripped = v.replace(/^[vV]/, "");
  const [core, ...rest] = stripped.split("-");
  const pre = rest.length > 0 ? rest.join("-") : null;
  const segs = (core ?? "").split(".").map(Number);
  return {
    nums: [segs[0] || 0, segs[1] || 0, segs[2] || 0],
    pre,
  };
}

/**
 * Compare two pre-release strings per semver §11:
 *   - Dot-separated identifiers compared left to right.
 *   - Both numeric → compare as integers.
 *   - Both non-numeric → compare lexically.
 *   - Numeric vs non-numeric → numeric sorts lower (§11.4.4).
 *   - Fewer identifiers sorts earlier when all preceding are equal.
 */
function comparePreRelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) {
      return -1;
    } // a has fewer fields → a < b
    if (i >= pb.length) {
      return 1;
    }
    const aIsNum = /^\d+$/.test(pa[i]);
    const bIsNum = /^\d+$/.test(pb[i]);
    if (aIsNum && bIsNum) {
      const diff = Number(pa[i]) - Number(pb[i]);
      if (diff !== 0) {
        return diff;
      }
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1; // numeric < non-numeric per §11.4.4
    } else {
      const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (cmp !== 0) {
        return cmp;
      }
    }
  }
  return 0;
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * Handles pre-release suffixes per semver spec:
 *   - `0.6.0-staging.1 < 0.6.0` (pre-release < release)
 *   - `0.6.0-staging.1 < 0.6.0-staging.2` (numeric postfix comparison)
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa.nums[i] - pb.nums[i];
    if (diff !== 0) {
      return diff;
    }
  }
  // Same major.minor.patch — compare pre-release
  if (pa.pre === null && pb.pre === null) {
    return 0;
  }
  if (pa.pre !== null && pb.pre === null) {
    return -1;
  } // pre-release < release
  if (pa.pre === null && pb.pre !== null) {
    return 1;
  }
  return comparePreRelease(pa.pre!, pb.pre!);
}
