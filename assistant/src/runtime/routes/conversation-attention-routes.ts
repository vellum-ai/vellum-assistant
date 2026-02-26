/**
 * Route handler for the conversation attention API.
 * Exposes attention state (seen/unseen) for conversations,
 * useful for assistant/LLM reporting and UI indicators.
 */

import {
  type AttentionFilterState,
  listConversationAttention,
} from '../../memory/conversation-attention-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { truncate } from '../../util/truncate.js';

export function handleListConversationAttention(url: URL): Response {
  const stateParam = url.searchParams.get('state') ?? 'all';
  const sourceParam = url.searchParams.get('source') ?? 'all';
  const channel = url.searchParams.get('channel') ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 100);
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam ? Number(beforeParam) : undefined;

  if (!['seen', 'unseen', 'all'].includes(stateParam)) {
    return Response.json({ error: 'Invalid state parameter. Must be seen, unseen, or all.' }, { status: 400 });
  }

  const attentionStates = listConversationAttention({
    assistantId: 'self',
    state: stateParam as AttentionFilterState,
    sourceChannel: channel,
    limit: limit + 1, // fetch one extra to determine hasMore
    before,
  });

  const hasMore = attentionStates.length > limit;
  const pageStates = hasMore ? attentionStates.slice(0, limit) : attentionStates;

  // Batch-fetch conversation metadata for title and source filtering
  const conversationIds = pageStates.map((s) => s.conversationId);
  const conversationMap = new Map<string, { title: string | null; source: string }>();
  for (const id of conversationIds) {
    const conv = conversationStore.getConversation(id);
    if (conv) {
      conversationMap.set(id, { title: conv.title, source: conv.source ?? 'user' });
    }
  }

  let results = pageStates.map((attn) => {
    const conv = conversationMap.get(attn.conversationId);
    const convSource = conv?.source ?? 'user';
    const hasUnseen = attn.latestAssistantMessageAt !== null &&
      (attn.lastSeenAssistantMessageAt === null || attn.lastSeenAssistantMessageAt < attn.latestAssistantMessageAt);
    const state: 'seen' | 'unseen' | 'no_assistant_message' = attn.latestAssistantMessageAt === null
      ? 'no_assistant_message'
      : hasUnseen ? 'unseen' : 'seen';

    return {
      conversationId: attn.conversationId,
      title: conv?.title ?? null,
      source: convSource,
      state,
      latestAssistantMessageAt: attn.latestAssistantMessageAt,
      latestAssistantSnippet: null as string | null,
      lastSeenAssistantMessageAt: attn.lastSeenAssistantMessageAt,
      lastSeenConfidence: attn.lastSeenConfidence,
      lastSeenSignalType: attn.lastSeenSignalType,
      lastSeenSourceChannel: attn.lastSeenSourceChannel,
      lastSeenSource: attn.lastSeenSource,
      lastSeenEvidenceText: attn.lastSeenEvidenceText ? truncate(attn.lastSeenEvidenceText, 200, '') : null,
    };
  });

  // Apply source filter client-side (attention store doesn't know about conversation source)
  if (sourceParam !== 'all') {
    results = results.filter((r) => r.source === sourceParam);
  }

  return Response.json({
    conversations: results,
    hasMore,
  });
}
