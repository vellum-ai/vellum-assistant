/**
 * Route handlers for conversation messages and suggestions.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  getConversationByKey,
  getOrCreateConversation,
} from '../../memory/conversation-key-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import { renderHistoryContent, mergeToolResults } from '../../daemon/handlers.js';
import { getConfig } from '../../config/loader.js';
import { getFailoverProvider, listProviders } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import type {
  MessageProcessor,
  NonBlockingMessageProcessor,
  RuntimeAttachmentMetadata,
  RuntimeMessagePayload,
} from '../http-types.js';

const SUGGESTION_CACHE_MAX = 100;

function getInterfaceFilesWithMtimes(interfacesDir: string | null): Array<{ path: string; mtimeMs: number }> {
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
  url: URL,
  interfacesDir: string | null,
): Response {
  const conversationId = url.searchParams.get('conversationId');
  const conversationKey = url.searchParams.get('conversationKey');

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
  } else {
    return Response.json(
      { error: 'conversationKey or conversationId query parameter is required' },
      { status: 400 },
    );
  }

  if (!resolvedConversationId) {
    return Response.json({ messages: [] });
  }
  const rawMessages = conversationStore.getMessages(resolvedConversationId);

  // Parse content blocks and extract text + tool calls
  const parsed = rawMessages.map((msg) => {
    let content: unknown;
    try { content = JSON.parse(msg.content); } catch { content = msg.content; }
    const rendered = renderHistoryContent(content);
    return {
      role: msg.role,
      text: rendered.text,
      timestamp: msg.createdAt,
      toolCalls: rendered.toolCalls,
      toolCallsBeforeText: rendered.toolCallsBeforeText,
      textSegments: rendered.textSegments,
      contentOrder: rendered.contentOrder,
      surfaces: rendered.surfaces,
      id: msg.id,
    };
  });

  // Merge tool_result data from internal user messages into the
  // preceding assistant message's toolCalls, and suppress those
  // internal user messages from the visible history.
  const merged = mergeToolResults(parsed);

  const interfaceFiles = getInterfaceFilesWithMtimes(interfacesDir);

  let prevAssistantTimestamp = 0;
  const messages: RuntimeMessagePayload[] = merged.map((m) => {
    let msgAttachments: RuntimeAttachmentMetadata[] = [];
    if (m.role === 'assistant' && m.id) {
      const linked = attachmentsStore.getAttachmentMetadataForMessage(m.id);
      if (linked.length > 0) {
        msgAttachments = linked.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          kind: a.kind,
        }));
      }
    }

    let interfaces: string[] | undefined;
    if (m.role === 'assistant') {
      const msgTimestamp = new Date(m.timestamp).getTime();
      const dirtied = interfaceFiles
        .filter((f) => f.mtimeMs > prevAssistantTimestamp && f.mtimeMs <= msgTimestamp)
        .map((f) => f.path);
      if (dirtied.length > 0) {
        interfaces = dirtied;
      }
      prevAssistantTimestamp = msgTimestamp;
    }

    return {
      id: m.id ?? '',
      role: m.role,
      content: m.text,
      timestamp: new Date(m.timestamp).toISOString(),
      attachments: msgAttachments,
      ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      ...(interfaces ? { interfaces } : {}),
    };
  });

  return Response.json({ messages });
}

export async function handleSendMessage(
  req: Request,
  deps: {
    processMessage?: MessageProcessor;
    persistAndProcessMessage?: NonBlockingMessageProcessor;
  },
): Promise<Response> {
  const body = await req.json() as {
    conversationKey?: string;
    content?: string;
    attachmentIds?: string[];
    sourceChannel?: string;
  };

  const { conversationKey, content, attachmentIds, sourceChannel } = body;

  if (!conversationKey) {
    return Response.json(
      { error: 'conversationKey is required' },
      { status: 400 },
    );
  }

  // Reject non-string content values (numbers, objects, etc.)
  if (content !== undefined && content !== null && typeof content !== 'string') {
    return Response.json(
      { error: 'content must be a string' },
      { status: 400 },
    );
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    return Response.json(
      { error: 'content or attachmentIds is required' },
      { status: 400 },
    );
  }

  // Validate that all attachment IDs resolve
  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return Response.json(
        { error: `Attachment IDs not found: ${missing.join(', ')}` },
        { status: 400 },
      );
    }
  }

  const mapping = getOrCreateConversation(conversationKey);

  const processor = deps.persistAndProcessMessage ?? deps.processMessage;
  if (!processor) {
    return Response.json({ error: 'Message processing not configured' }, { status: 503 });
  }

  try {
    const result = await processor(
      mapping.conversationId,
      content ?? '',
      hasAttachments ? attachmentIds : undefined,
      undefined,
      sourceChannel,
    );
    return Response.json({ accepted: true, messageId: result.messageId });
  } catch (err) {
    if (err instanceof Error && err.message === 'Session is already processing a message') {
      return Response.json(
        { error: 'Session is busy processing another message. Please retry.' },
        { status: 409 },
      );
    }
    throw err;
  }
}

async function generateLlmSuggestion(provider: Provider, assistantText: string): Promise<string | null> {
  const truncated = assistantText.length > 2000
    ? assistantText.slice(-2000)
    : assistantText;

  const prompt = `Given this assistant message, write a very short tab-complete suggestion (max 50 chars) the user could send next to keep the conversation going. Be casual, curious, or actionable — like a quick reply, not a formal request. Reply with ONLY the suggestion text.\n\nAssistant's message:\n${truncated}`;
  const response = await provider.sendMessage(
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    [], // no tools
    undefined, // no system prompt
    { config: { max_tokens: 30 } },
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

  if (!raw) return null;

  // Take first line only, then enforce the length cap
  const firstLine = raw.split('\n')[0].trim();
  if (!firstLine || firstLine.length > 50) return null;
  return firstLine;
}

export async function handleGetSuggestion(
  url: URL,
  deps: {
    suggestionCache: Map<string, string>;
    suggestionInFlight: Map<string, Promise<string | null>>;
  },
): Promise<Response> {
  const conversationKey = url.searchParams.get('conversationKey');
  if (!conversationKey) {
    return Response.json(
      { error: 'conversationKey query parameter is required' },
      { status: 400 },
    );
  }

  const mapping = getConversationByKey(conversationKey);
  if (!mapping) {
    return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
  }

  const rawMessages = conversationStore.getMessages(mapping.conversationId);
  if (rawMessages.length === 0) {
    return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
  }

  // Staleness check: compare requested messageId against the latest
  // assistant message BEFORE filtering by text content.  This ensures
  // that a newer tool-only assistant turn (empty text) still causes
  // older messageId requests to be correctly marked as stale.
  const requestedMessageId = url.searchParams.get('messageId');
  if (requestedMessageId) {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === 'assistant') {
        if (rawMessages[i].id !== requestedMessageId) {
          return Response.json({ suggestion: null, messageId: null, source: 'none' as const, stale: true });
        }
        break;
      }
    }
  }

  const { suggestionCache, suggestionInFlight } = deps;
  const log = (await import('../../util/logger.js')).getLogger('runtime-http');

  // Walk backwards to find the last assistant message with text content
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role !== 'assistant') continue;

    let content: unknown;
    try { content = JSON.parse(msg.content); } catch { content = msg.content; }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) continue;

    // If a messageId was requested and the first text-bearing assistant
    // message is a *different* message, the request is stale.
    if (requestedMessageId && msg.id !== requestedMessageId) {
      return Response.json({ suggestion: null, messageId: null, source: 'none' as const, stale: true });
    }

    // Return cached suggestion if we already generated one for this message
    const cached = suggestionCache.get(msg.id);
    if (cached !== undefined) {
      return Response.json({
        suggestion: cached,
        messageId: msg.id,
        source: 'llm' as const,
      });
    }

    // Try LLM suggestion using the configured provider
    const config = getConfig();
    if (listProviders().includes(config.provider)) {
      try {
        const provider = getFailoverProvider(config.provider, config.providerOrder);
        // Deduplicate concurrent requests
        let promise = suggestionInFlight.get(msg.id);
        if (!promise) {
          promise = generateLlmSuggestion(provider, text);
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

          return Response.json({
            suggestion: llmSuggestion,
            messageId: msg.id,
            source: 'llm' as const,
          });
        }
      } catch (err) {
        suggestionInFlight.delete(msg.id);
        log.warn({ err }, 'LLM suggestion failed');
      }
    }

    return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
  }

  return Response.json({ suggestion: null, messageId: null, source: 'none' as const });
}

/**
 * GET /search?q=<query>[&limit=<n>][&maxMessagesPerConversation=<n>]
 *
 * Full-text search across all conversation threads (message content + titles).
 * Returns ranked results grouped by conversation, each with matching message excerpts.
 */
export function handleSearchConversations(url: URL): Response {
  const query = url.searchParams.get('q') ?? '';
  if (!query.trim()) {
    return Response.json(
      { error: 'q query parameter is required' },
      { status: 400 },
    );
  }

  const limit = url.searchParams.has('limit')
    ? Number(url.searchParams.get('limit'))
    : undefined;
  const maxMessagesPerConversation = url.searchParams.has('maxMessagesPerConversation')
    ? Number(url.searchParams.get('maxMessagesPerConversation'))
    : undefined;

  const results = conversationStore.searchConversations(query, {
    ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
    ...(maxMessagesPerConversation !== undefined && !isNaN(maxMessagesPerConversation) ? { maxMessagesPerConversation } : {}),
  });

  return Response.json({ query, results });
}
