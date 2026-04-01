import { v4 as uuid } from "uuid";

import { getConfig } from "../../config/loader.js";
import type { Speed } from "../../config/schemas/inference.js";
import type { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import type { SecretPromptResult } from "../../permissions/secret-prompter.js";
import type { AuthContext } from "../../runtime/auth/types.js";
import type { DebouncerMap } from "../../util/debounce.js";
import { getLogger } from "../../util/logger.js";
import { estimateBase64Bytes } from "../assistant-attachments.js";
import { Conversation } from "../conversation.js";
import type { TrustContext } from "../conversation-runtime-assembly.js";
import type {
  ConversationTransportMetadata,
  ServerMessage,
} from "../message-protocol.js";

const log = getLogger("handlers");

export { log };

/** Debounce window for suppressing file-watcher config reloads after programmatic saves. */
export const CONFIG_RELOAD_DEBOUNCE_MS = 300;

const HISTORY_ATTACHMENT_TEXT_LIMIT = 500;

// Module-level map for non-conversation secret prompts (e.g. publish_page)
export const pendingStandaloneSecrets = new Map<
  string,
  {
    resolve: (result: SecretPromptResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// Pending signing responses (bundle signing orchestration), keyed by unique requestId
interface PendingSigningResolve {
  resolve: (result: {
    signature: string;
    keyId: string;
    publicKey: string;
  }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export const pendingSignBundlePayload = new Map<
  string,
  PendingSigningResolve
>();

interface PendingIdentityResolve {
  resolve: (result: { keyId: string; publicKey: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export const pendingSigningIdentity = new Map<string, PendingIdentityResolve>();

export interface HistoryToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
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
}

export interface HistorySurface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{ id: string; label: string; style?: string }>;
  display?: string;
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
 * Optional overrides for conversation creation (e.g. interview mode).
 */
export interface ConversationCreateOptions {
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  speed?: Speed;
  transport?: ConversationTransportMetadata;
  assistantId?: string;
  trustContext?: TrustContext;
  /** Normalized auth context for the conversation. */
  authContext?: AuthContext;
  /** Whether this turn can block on interactive approval prompts. */
  isInteractive?: boolean;
  memoryScopeId?: string;
  isPrivateConversation?: boolean;
  strictPrivateSideEffects?: boolean;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  /** Optional callback to receive real-time agent loop events (text deltas, tool starts, etc.). */
  onEvent?: (msg: ServerMessage) => void;
}

/**
 * Shared context that handlers need from the DaemonServer.
 * Keeps handlers decoupled from the server class itself.
 */
export interface HandlerContext {
  conversations: Map<string, Conversation>;
  sharedRequestTimestamps: number[];
  debounceTimers: DebouncerMap;
  suppressConfigReload: boolean;
  setSuppressConfigReload(value: boolean): void;
  updateConfigFingerprint(): void;
  send(msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  clearAllConversations(): number;
  getOrCreateConversation(
    conversationId: string,
    options?: ConversationCreateOptions,
  ): Promise<Conversation>;
  /** Refresh the eviction timestamp for a conversation that was accessed directly. */
  touchConversation(conversationId: string): void;
  /** Optional heartbeat service reference for "Run Now" support. */
  heartbeatService?: HeartbeatService;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

export function formatBytes(sizeBytes: number): string {
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
      toolCalls.push(entry);
      if (id) pendingToolUses.set(id, entry);
      contentOrder.push(`tool:${toolCalls.length - 1}`);
      if (!seenToolUse) {
        seenToolUse = true;
        if (!seenText) toolCallsBeforeText = true;
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
        if (imageDataList.length > 0) matched.imageDataList = imageDataList;
      } else {
        toolCalls.push({
          name: "unknown",
          input: {},
          result: resultContent,
          isError,
          ...(imageDataList.length > 0 ? { imageDataList } : {}),
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
 * outside of a conversation context (e.g. from handler-level code like publish_page).
 */
export function requestSecretStandalone(
  ctx: HandlerContext,
  params: {
    service: string;
    field: string;
    label: string;
    description?: string;
    placeholder?: string;
    purpose?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
  },
): Promise<SecretPromptResult> {
  const requestId = uuid();
  const config = getConfig();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingStandaloneSecrets.delete(requestId);
      resolve({ value: null, delivery: "store" });
    }, config.timeouts.permissionTimeoutSec * 1000);
    pendingStandaloneSecrets.set(requestId, { resolve, timer });
    ctx.send({
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

const SIGNING_TIMEOUT_MS = 30_000;

/**
 * Create a SigningCallback that sends `sign_bundle_payload` to the Swift client
 * over HTTP and waits for the `sign_bundle_payload_response`.
 */
export function createSigningCallback(
  ctx: HandlerContext,
): (
  payload: string,
) => Promise<{ signature: string; keyId: string; publicKey: string }> {
  return (payload: string) =>
    new Promise((resolve, reject) => {
      const requestId = uuid();
      const timer = setTimeout(() => {
        pendingSignBundlePayload.delete(requestId);
        reject(new Error("Signing request timed out"));
      }, SIGNING_TIMEOUT_MS);
      pendingSignBundlePayload.set(requestId, { resolve, reject, timer });
      ctx.send({ type: "sign_bundle_payload", requestId, payload });
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

/** Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
