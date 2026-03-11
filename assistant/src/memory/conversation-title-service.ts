/**
 * Shared conversation title generation service.
 *
 * Provides a single reusable primitive for generating and persisting
 * conversation titles across all creation paths. Enforces a safe
 * overwrite policy: only replaceable placeholder/system titles are
 * overwritten, never user-provided custom titles.
 */

import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import {
  getConversation,
  getMessages,
  type MessageRow,
  updateConversationTitle,
} from "./conversation-crud.js";

const log = getLogger("conversation-title-service");

// ── Types ────────────────────────────────────────────────────────────

export type TitleOrigin =
  | "runtime_api"
  | "channel_inbound"
  | "voice_outbound"
  | "voice_inbound"
  | "guardian_request"
  | "schedule"
  | "task"
  | "watcher"
  | "subagent"
  | "sequence"
  | "heartbeat"
  | "local"
  | "task_submit"
  | "misc";

export interface TitleContext {
  origin: TitleOrigin;
  conversationKey?: string;
  sourceChannel?: string;
  assistantId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  triggerTextSnippet?: string;
  systemHint?: string;
  metadataHints?: string[];
  uxBrief?: string;
}

// ── Placeholder / loading state ──────────────────────────────────────

export const GENERATING_TITLE = "Generating title...";
export const UNTITLED_FALLBACK = "Untitled Conversation";

// ── Replaceability check ─────────────────────────────────────────────

const REPLACEABLE_PATTERNS = [
  /^Runtime:\s/,
  /^New Conversation$/,
  /^Untitled$/,
  /^Untitled Conversation$/,
  /^Generating title\.\.\.$/,
];

/**
 * Check whether a title is a system-generated placeholder that can be
 * safely overwritten by auto-generated titles. Returns `false` for
 * user-provided custom titles.
 */
export function isReplaceableTitle(title: string | null): boolean {
  if (title == null || title.trim() === "") return true;
  return REPLACEABLE_PATTERNS.some((pattern) => pattern.test(title));
}

// ── Title generation ─────────────────────────────────────────────────

export interface GenerateTitleParams {
  conversationId: string;
  /** Provider to use for LLM call. Falls back to getConfiguredProvider(). */
  provider?: Provider;
  /** Context about how/where the conversation was created. */
  context?: TitleContext;
  /** User message text (first turn). */
  userMessage?: string;
  /** Assistant response text (first turn). */
  assistantResponse?: string;
  /** Callback to emit title update events. */
  onTitleUpdated?: (title: string) => void;
  /** Abort signal. */
  signal?: AbortSignal;
}

/**
 * Generate a conversation title via LLM and persist it, but only if the
 * current title is still replaceable (safe overwrite policy).
 */
export async function generateAndPersistConversationTitle(
  params: GenerateTitleParams,
): Promise<{ title: string; updated: boolean }> {
  const {
    conversationId,
    context,
    userMessage,
    assistantResponse,
    onTitleUpdated,
    signal,
  } = params;

  // Check current title is replaceable
  const conversation = getConversation(conversationId);
  if (conversation && !isReplaceableTitle(conversation.title)) {
    return { title: conversation.title!, updated: false };
  }

  const provider = params.provider ?? getConfiguredProvider();
  if (!provider) {
    // No provider available — fall back to context-derived title or untitled
    const fallback = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
    updateConversationTitle(conversationId, fallback, 1);
    onTitleUpdated?.(fallback);
    return { title: fallback, updated: true };
  }

  const config = getConfig();
  const prompt = buildTitlePrompt(context, userMessage, assistantResponse);
  const timeoutSignal = AbortSignal.timeout(10_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    undefined,
    {
      config: {
        max_tokens: config.daemon.titleGenerationMaxTokens,
        modelIntent: "latency-optimized",
      },
      signal: combinedSignal,
    },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock && textBlock.type === "text") {
    let title = normalizeTitle(textBlock.text);
    if (!title) {
      title = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
    }

    // Re-check replaceability before persisting (race guard)
    const current = getConversation(conversationId);
    if (current && !isReplaceableTitle(current.title)) {
      return { title: current.title!, updated: false };
    }

    updateConversationTitle(conversationId, title, 1);
    onTitleUpdated?.(title);
    log.info({ conversationId, title }, "Auto-generated conversation title");
    return { title, updated: true };
  }

  // No text in response — use fallback
  // Re-check replaceability before persisting (race guard — same as the
  // text-response path above). A concurrent custom rename may have landed
  // while the LLM request was in-flight; writing unconditionally would
  // clobber the user's intent.
  const currentForFallback = getConversation(conversationId);
  if (currentForFallback && !isReplaceableTitle(currentForFallback.title)) {
    return { title: currentForFallback.title!, updated: false };
  }

  const fallback = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
  updateConversationTitle(conversationId, fallback, 1);
  onTitleUpdated?.(fallback);
  return { title: fallback, updated: true };
}

/**
 * Fire-and-forget wrapper for title generation. Failures are logged
 * but do not propagate. On failure, replaces loading placeholder with
 * a stable fallback title so loading state is never permanent.
 */
export function queueGenerateConversationTitle(
  params: GenerateTitleParams,
): void {
  generateAndPersistConversationTitle(params).catch((err) => {
    log.warn(
      { err, conversationId: params.conversationId },
      "Failed to generate conversation title (non-fatal)",
    );
    // Replace loading placeholder with stable fallback
    try {
      const conversation = getConversation(params.conversationId);
      if (conversation && conversation.title === GENERATING_TITLE) {
        const fallback =
          deriveFallbackTitle(params.context) ?? UNTITLED_FALLBACK;
        updateConversationTitle(params.conversationId, fallback);
        params.onTitleUpdated?.(fallback);
      }
    } catch {
      // Best-effort
    }
  });
}

// ── Title regeneration (second pass) ─────────────────────────────────

export interface RegenerateTitleParams {
  conversationId: string;
  provider?: Provider;
  onTitleUpdated?: (title: string) => void;
  signal?: AbortSignal;
}

/**
 * Re-generate a conversation title using the last 3 stored messages.
 * Only fires when the current title was auto-generated (isAutoTitle = 1).
 * Skips if the user has manually renamed the conversation.
 */
export async function regenerateConversationTitle(
  params: RegenerateTitleParams,
): Promise<{ title: string; updated: boolean }> {
  const { conversationId, onTitleUpdated, signal } = params;

  const conversation = getConversation(conversationId);
  if (!conversation || !conversation.isAutoTitle) {
    return { title: conversation?.title ?? UNTITLED_FALLBACK, updated: false };
  }

  const provider = params.provider ?? getConfiguredProvider();
  if (!provider) {
    return { title: conversation.title ?? UNTITLED_FALLBACK, updated: false };
  }

  const allMessages = getMessages(conversationId);
  const recentMessages = allMessages.slice(-3);
  if (recentMessages.length === 0) {
    return { title: conversation.title ?? UNTITLED_FALLBACK, updated: false };
  }

  const prompt = buildRegenerationPrompt(recentMessages);
  const config = getConfig();
  const timeoutSignal = AbortSignal.timeout(10_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    undefined,
    {
      config: {
        max_tokens: config.daemon.titleGenerationMaxTokens,
        modelIntent: "latency-optimized",
      },
      signal: combinedSignal,
    },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock && textBlock.type === "text") {
    const title = normalizeTitle(textBlock.text);
    if (!title) {
      return { title: conversation.title ?? UNTITLED_FALLBACK, updated: false };
    }

    // Re-check isAutoTitle before persisting (race guard against manual rename)
    const current = getConversation(conversationId);
    if (!current || !current.isAutoTitle) {
      return { title: current?.title ?? UNTITLED_FALLBACK, updated: false };
    }

    updateConversationTitle(conversationId, title, 1);
    onTitleUpdated?.(title);
    log.info(
      { conversationId, title },
      "Re-generated conversation title (second pass)",
    );
    return { title, updated: true };
  }

  return { title: conversation.title ?? UNTITLED_FALLBACK, updated: false };
}

/**
 * Fire-and-forget wrapper for title regeneration.
 */
export function queueRegenerateConversationTitle(
  params: RegenerateTitleParams,
): void {
  regenerateConversationTitle(params).catch((err) => {
    log.warn(
      { err, conversationId: params.conversationId },
      "Failed to regenerate conversation title (non-fatal)",
    );
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

function buildTitlePrompt(
  context?: TitleContext,
  userMessage?: string,
  assistantResponse?: string,
): string {
  const parts: string[] = [
    "Generate a very short title for this conversation. Rules: at most 5 words, at most 40 characters, no quotes, no markdown formatting.",
  ];

  if (context) {
    const hints: string[] = [];
    if (context.sourceChannel) hints.push(`Channel: ${context.sourceChannel}`);
    if (context.displayName) hints.push(`User: ${context.displayName}`);
    if (context.systemHint) hints.push(`Context: ${context.systemHint}`);
    if (context.uxBrief) hints.push(`Brief: ${context.uxBrief}`);
    if (context.metadataHints?.length)
      hints.push(`Hints: ${context.metadataHints.join(", ")}`);
    if (hints.length > 0) {
      parts.push("", "Metadata:", ...hints);
    }
  }

  if (userMessage) {
    parts.push("", `User: ${truncate(userMessage, 200, "")}`);
  }
  if (assistantResponse) {
    parts.push(`Assistant: ${truncate(assistantResponse, 200, "")}`);
  }

  return parts.join("\n");
}

function normalizeTitle(raw: string): string {
  let title = raw.trim().replace(/^["']|["']$/g, "");
  title = stripMarkdown(title);
  const words = title.split(/\s+/);
  if (words.length > 5) title = words.slice(0, 5).join(" ");
  if (title.length > 40) title = title.slice(0, 40).trimEnd();
  return title;
}

/** Strip common markdown formatting so titles render as plain text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/\*(.+?)\*/g, "$1") // *italic*
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1") // _italic_ (word-boundary-aware to preserve snake_case)
    .replace(/~~(.+?)~~/g, "$1") // ~~strikethrough~~
    .replace(/`(.+?)`/g, "$1") // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // [link](url)
    .replace(/^#{1,6}\s+/gm, ""); // # headings
}

function deriveFallbackTitle(context?: TitleContext): string | null {
  if (!context) return null;
  if (context.systemHint) return truncate(context.systemHint, 40, "");
  if (context.uxBrief) return truncate(context.uxBrief, 40, "");
  return null;
}

function buildRegenerationPrompt(recentMessages: MessageRow[]): string {
  const parts: string[] = [
    "Generate a very short title for this conversation based on the recent messages below. Rules: at most 5 words, at most 40 characters, no quotes, no markdown formatting.",
    "",
    "Recent messages:",
  ];

  for (const msg of recentMessages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    parts.push(`${role}: ${truncate(msg.content, 200, "")}`);
  }

  return parts.join("\n");
}
