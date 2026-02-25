/**
 * Shared conversation title generation service.
 *
 * Provides a single reusable primitive for generating and persisting
 * conversation titles across all creation paths. Enforces a safe
 * overwrite policy: only replaceable placeholder/system titles are
 * overwritten, never user-provided custom titles.
 */

import * as conversationStore from './conversation-store.js';
import { getConfiguredProvider } from '../providers/provider-send-message.js';
import { getConfig } from '../config/loader.js';
import { truncate } from '../util/truncate.js';
import { getLogger } from '../util/logger.js';
import type { Provider } from '../providers/types.js';

const log = getLogger('conversation-title-service');

// ── Types ────────────────────────────────────────────────────────────

export type TitleOrigin =
  | 'runtime_api'
  | 'channel_inbound'
  | 'voice_outbound'
  | 'voice_inbound'
  | 'guardian_request'
  | 'schedule'
  | 'reminder'
  | 'task'
  | 'watcher'
  | 'subagent'
  | 'heartbeat'
  | 'ipc'
  | 'task_submit'
  | 'misc';

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

export const GENERATING_TITLE = 'Generating title...';
export const UNTITLED_FALLBACK = 'Untitled Conversation';

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
  if (title == null || title.trim() === '') return true;
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
  const { conversationId, context, userMessage, assistantResponse, onTitleUpdated, signal } = params;

  // Check current title is replaceable
  const conversation = conversationStore.getConversation(conversationId);
  if (conversation && !isReplaceableTitle(conversation.title)) {
    return { title: conversation.title!, updated: false };
  }

  const provider = params.provider ?? getConfiguredProvider();
  if (!provider) {
    // No provider available — fall back to context-derived title or untitled
    const fallback = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
    conversationStore.updateConversationTitle(conversationId, fallback);
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
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    [],
    undefined,
    { config: { max_tokens: config.daemon.titleGenerationMaxTokens }, signal: combinedSignal },
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    let title = normalizeTitle(textBlock.text);
    if (!title) {
      title = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
    }

    // Re-check replaceability before persisting (race guard)
    const current = conversationStore.getConversation(conversationId);
    if (current && !isReplaceableTitle(current.title)) {
      return { title: current.title!, updated: false };
    }

    conversationStore.updateConversationTitle(conversationId, title);
    onTitleUpdated?.(title);
    log.info({ conversationId, title }, 'Auto-generated conversation title');
    return { title, updated: true };
  }

  // No text in response — use fallback
  const fallback = deriveFallbackTitle(context) ?? UNTITLED_FALLBACK;
  conversationStore.updateConversationTitle(conversationId, fallback);
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
      'Failed to generate conversation title (non-fatal)',
    );
    // Replace loading placeholder with stable fallback
    try {
      const conversation = conversationStore.getConversation(params.conversationId);
      if (conversation && conversation.title === GENERATING_TITLE) {
        const fallback = deriveFallbackTitle(params.context) ?? UNTITLED_FALLBACK;
        conversationStore.updateConversationTitle(params.conversationId, fallback);
        params.onTitleUpdated?.(fallback);
      }
    } catch {
      // Best-effort
    }
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

function buildTitlePrompt(
  context?: TitleContext,
  userMessage?: string,
  assistantResponse?: string,
): string {
  const parts: string[] = [
    'Generate a very short title for this conversation. Rules: at most 5 words, at most 40 characters, no quotes.',
  ];

  if (context) {
    const hints: string[] = [];
    if (context.sourceChannel) hints.push(`Channel: ${context.sourceChannel}`);
    if (context.displayName) hints.push(`User: ${context.displayName}`);
    if (context.systemHint) hints.push(`Context: ${context.systemHint}`);
    if (context.uxBrief) hints.push(`Brief: ${context.uxBrief}`);
    if (context.metadataHints?.length) hints.push(`Hints: ${context.metadataHints.join(', ')}`);
    if (hints.length > 0) {
      parts.push('', 'Metadata:', ...hints);
    }
  }

  if (userMessage) {
    parts.push('', `User: ${truncate(userMessage, 200, '')}`);
  }
  if (assistantResponse) {
    parts.push(`Assistant: ${truncate(assistantResponse, 200, '')}`);
  }

  return parts.join('\n');
}

function normalizeTitle(raw: string): string {
  let title = raw.trim().replace(/^["']|["']$/g, '');
  const words = title.split(/\s+/);
  if (words.length > 5) title = words.slice(0, 5).join(' ');
  if (title.length > 40) title = title.slice(0, 40).trimEnd();
  return title;
}

function deriveFallbackTitle(context?: TitleContext): string | null {
  if (!context) return null;
  if (context.systemHint) return truncate(context.systemHint, 40, '');
  if (context.uxBrief) return truncate(context.uxBrief, 40, '');
  return null;
}
