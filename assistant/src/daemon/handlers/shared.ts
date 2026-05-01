import { v4 as uuid } from "uuid";

import { getConfig } from "../../config/loader.js";
import type { LLMCallSite, Speed } from "../../config/schemas/llm.js";
import type { SecretPromptResult } from "../../permissions/secret-prompter.js";
import { isPlaceholderSentinelText } from "../../providers/anthropic/client.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import type { AuthContext } from "../../runtime/auth/types.js";
import { getLogger } from "../../util/logger.js";
import { estimateBase64Bytes } from "../assistant-attachments.js";
import type { ConversationTransportMetadata } from "../message-protocol.js";
import type { TrustContext } from "../trust-context.js";

const log = getLogger("handlers");

export { log };

/** Debounce window for suppressing file-watcher config reloads after programmatic saves. */
export const CONFIG_RELOAD_DEBOUNCE_MS = 300;

const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

// Module-level map for non-conversation secret prompts (e.g. publish_page)
const pendingStandaloneSecrets = new Map<
  string,
  {
    resolve: (result: SecretPromptResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

export interface HistoryToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). @deprecated Use imageDataList. */
  imageData?: string;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot, image generation). */
  imageDataList?: string[];
  /** Unix ms when the tool started executing. */
  startedAt?: number;
  /** Unix ms when the tool completed. */
  completedAt?: number;
  /** Confirmation decision for this tool call: "approved" | "denied" | "timed_out". */
  confirmationDecision?: string;
  /** Friendly label for the confirmation (e.g. "Edit File", "Run Command"). */
  confirmationLabel?: string;
  /** Risk level classification at invocation time ("low" | "medium" | "high" | "unknown"). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /**
   * @deprecated Use `approvalMode` and `approvalReason` instead.
   * Kept for backward compatibility during the migration window.
   */
  autoApproved?: boolean;
  /** How the approval decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
}

export interface HistorySurface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{ id: string; label: string; style?: string }>;
  display?: string;
  persistent?: boolean;
  completed?: boolean;
  completionSummary?: string;
}

export interface RenderedHistoryContent {
  text: string;
  toolCalls: HistoryToolCall[];
  /** True when the first tool_use block appeared before any text block. */
  toolCallsBeforeText: boolean;
  /** Text segments split by tool-call boundaries. */
  textSegments: string[];
  /** Content block ordering using "text:N", "tool:N", "surface:N" encoding. */
  contentOrder: string[];
  /** UI surfaces (widgets) embedded in the message. */
  surfaces: HistorySurface[];
  /** Thinking segments extracted from thinking blocks. */
  thinkingSegments: string[];
}

/**
 * Slack-specific metadata extracted at the inbound HTTP boundary and threaded
 * through to user-message persistence so the row can be tagged with a
 * `slackMeta` envelope for the chronological renderer.
 */
export interface SlackInboundMessageMetadata {
  /** Slack channel id (conversation external id) — recorded as `channelId`. */
  channelId: string;
  /** Slack `ts` for this message — required so persistence can record `channelTs`. */
  channelTs: string;
  /** Parent `thread_ts` when the message lives inside a thread; absent for top-level. */
  threadTs?: string;
  /** Resolved sender label (display name preferred, username fallback). */
  displayName?: string;
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
  /** Slack-only non-persisted notice injected into the active model turn. */
  slackRuntimeContextNotice?: string;
  memoryScopeId?: string;
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
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function clampAttachmentText(text: string): string {
  if (text.length <= HISTORY_ATTACHMENT_TEXT_LIMIT) return text;
  return `${text.slice(0, HISTORY_ATTACHMENT_TEXT_LIMIT)}<truncated />`;
}

function renderFileBlockForHistory(block: Record<string, unknown>): string {
  const source = isRecord(block.source) ? block.source : null;
  const mediaType =
    source && typeof source.media_type === "string"
      ? source.media_type
      : "application/octet-stream";
  const filename =
    source && typeof source.filename === "string"
      ? source.filename
      : "attachment";
  const sizeBytes =
    source && typeof source.data === "string"
      ? estimateBase64Bytes(source.data)
      : 0;
  const summaryParts = [`[File attachment] ${filename}`, `type=${mediaType}`];
  if (sizeBytes > 0) summaryParts.push(`size=${formatBytes(sizeBytes)}`);

  const extractedText =
    typeof block.extracted_text === "string" ? block.extracted_text.trim() : "";
  if (!extractedText) {
    return summaryParts.join(", ");
  }
  return `${summaryParts.join(", ")}\nAttachment text: ${clampAttachmentText(
    extractedText,
  )}`;
}

export function renderHistoryContent(content: unknown): RenderedHistoryContent {
  if (!Array.isArray(content)) {
    let text: string;
    if (content == null) {
      text = "";
    } else if (typeof content === "object") {
      text = JSON.stringify(content);
    } else {
      text = String(content);
    }
    return {
      text,
      toolCalls: [],
      toolCallsBeforeText: false,
      textSegments: text ? [text] : [],
      contentOrder: text ? ["text:0"] : [],
      surfaces: [],
      thinkingSegments: [],
    };
  }

  const textParts: string[] = [];
  const attachmentParts: string[] = [];
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

  function joinWithSpacing(parts: string[]): string {
    let result = parts[0] ?? "";
    for (let i = 1; i < parts.length; i++) {
      const prev = result[result.length - 1];
      const next = parts[i][0];
      // Only insert a space when neither side already has whitespace
      if (
        prev &&
        next &&
        prev !== " " &&
        prev !== "\n" &&
        prev !== "\t" &&
        next !== " " &&
        next !== "\n" &&
        next !== "\t"
      ) {
        result += " ";
      }
      result += parts[i];
    }
    return result;
  }

  function finalizeSegment(): void {
    if (hasOpenSegment) {
      textSegments[textSegments.length - 1] =
        joinWithSpacing(currentSegmentParts);
      currentSegmentParts = [];
      hasOpenSegment = false;
    }
  }

  function ensureSegment(): void {
    if (!hasOpenSegment) {
      textSegments.push("");
      contentOrder.push(`text:${textSegments.length - 1}`);
      hasOpenSegment = true;
    }
  }

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

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
      };
      surfaces.push(surface);
      contentOrder.push(`surface:${surfaces.length - 1}`);
      continue;
    }

    if (block.type === "thinking" && typeof block.thinking === "string") {
      finalizeSegment();
      thinkingSegments.push(block.thinking);
      contentOrder.push(`thinking:${thinkingSegments.length - 1}`);
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      // Skip empty/whitespace-only text blocks. During streaming the client
      // discards empty text deltas (guard !text.isEmpty), so including them
      // here produces a contentOrder that differs from the live streaming
      // path — e.g. empty segments between consecutive tool_use blocks that
      // break tool-call grouping in the UI.
      if (block.text.trim().length === 0) continue;
      // Drop Anthropic provider placeholder sentinels. These are injected
      // into outbound API requests to preserve role alternation and must
      // never be rendered to users. Belt-and-suspenders with the persist-
      // time filter in cleanAssistantContent and migration 222.
      if (isPlaceholderSentinelText(block.text)) continue;
      textParts.push(block.text);
      ensureSegment();
      currentSegmentParts.push(block.text);
      seenText = true;
      continue;
    }
    if (block.type === "file") {
      attachmentParts.push(renderFileBlockForHistory(block));
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
      // Extract persisted timing/confirmation metadata
      if (typeof block._startedAt === "number")
        entry.startedAt = block._startedAt;
      if (typeof block._completedAt === "number")
        entry.completedAt = block._completedAt;
      if (typeof block._confirmationDecision === "string")
        entry.confirmationDecision = block._confirmationDecision;
      if (typeof block._confirmationLabel === "string")
        entry.confirmationLabel = block._confirmationLabel;
      if (typeof block._riskLevel === "string")
        entry.riskLevel = block._riskLevel;
      if (typeof block._riskReason === "string")
        entry.riskReason = block._riskReason;
      if (typeof block._matchedTrustRuleId === "string")
        entry.matchedTrustRuleId = block._matchedTrustRuleId;
      if (typeof block._autoApproved === "boolean")
        entry.autoApproved = block._autoApproved;
      if (typeof block._approvalMode === "string")
        entry.approvalMode = block._approvalMode;
      if (typeof block._approvalReason === "string")
        entry.approvalReason = block._approvalReason;
      if (typeof block._riskThreshold === "string")
        entry.riskThreshold = block._riskThreshold;
      toolCalls.push(entry);
      if (id) pendingToolUses.set(id, entry);
      contentOrder.push(`tool:${toolCalls.length - 1}`);
      if (!seenToolUse) {
        seenToolUse = true;
        if (!seenText) toolCallsBeforeText = true;
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
      toolCalls.push(entry);
      if (id) pendingToolUses.set(id, entry);
      contentOrder.push(`tool:${toolCalls.length - 1}`);
      if (!seenToolUse) {
        seenToolUse = true;
        if (!seenText) toolCallsBeforeText = true;
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
      // Extract base64 image data from persisted contentBlocks (e.g. browser_screenshot, image generation)
      const imageDataList: string[] = [];
      if (Array.isArray(block.contentBlocks)) {
        for (const cb of block.contentBlocks) {
          if (
            isRecord(cb) &&
            cb.type === "image" &&
            isRecord(cb.source) &&
            typeof (cb.source as Record<string, unknown>).data === "string"
          ) {
            imageDataList.push(
              (cb.source as Record<string, unknown>).data as string,
            );
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
      } else {
        toolCalls.push({
          name: "unknown",
          input: {},
          result: resultContent,
          isError,
          ...(imageDataList.length > 0
            ? { imageData: imageDataList[0], imageDataList }
            : {}),
        });
      }
      continue;
    }
  }

  // Include attachment descriptions in textSegments so that clients without
  // separate attachment UI (e.g. iOS) can display them via `message.text`.
  // The macOS client handles this by selecting the *first* non-empty text
  // segment in interleaved content, so trailing attachment segments are safe.
  if (attachmentParts.length > 0) {
    const attachmentText = attachmentParts.join("\n");
    const prefix = textParts.length > 0 ? "\n" : "";
    ensureSegment();
    currentSegmentParts.push(prefix + attachmentText);
  }

  finalizeSegment();

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
  };
}

/**
 * Send a `secret_request` to the client and wait for the response,
 * outside of a conversation context (e.g. from IPC routes like
 * credentials/prompt).
 */
export function requestSecretStandalone(params: {
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowedTools?: string[];
  allowedDomains?: string[];
}): Promise<SecretPromptResult> {
  const requestId = uuid();
  const config = getConfig();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingStandaloneSecrets.delete(requestId);
      resolve({ value: null, delivery: "store" });
    }, config.timeouts.permissionTimeoutSec * 1000);
    pendingStandaloneSecrets.set(requestId, { resolve, timer });
    broadcastMessage({
      type: "secret_request",
      requestId,
      service: params.service,
      field: params.field,
      label: params.label,
      description: params.description,
      placeholder: params.placeholder,
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
  if (!isRecord(raw.skills) || Array.isArray(raw.skills)) raw.skills = {};
  const skills = raw.skills as Record<string, unknown>;
  if (!isRecord(skills.entries) || Array.isArray(skills.entries))
    skills.entries = {};
  const entries = skills.entries as Record<string, unknown>;
  if (!isRecord(entries[name]) || Array.isArray(entries[name]))
    entries[name] = {};
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
    if (i >= pa.length) return -1; // a has fewer fields → a < b
    if (i >= pb.length) return 1;
    const aIsNum = /^\d+$/.test(pa[i]);
    const bIsNum = /^\d+$/.test(pb[i]);
    if (aIsNum && bIsNum) {
      const diff = Number(pa[i]) - Number(pb[i]);
      if (diff !== 0) return diff;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1; // numeric < non-numeric per §11.4.4
    } else {
      const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (cmp !== 0) return cmp;
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
    if (diff !== 0) return diff;
  }
  // Same major.minor.patch — compare pre-release
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre !== null && pb.pre === null) return -1; // pre-release < release
  if (pa.pre === null && pb.pre !== null) return 1;
  return comparePreRelease(pa.pre!, pb.pre!);
}
