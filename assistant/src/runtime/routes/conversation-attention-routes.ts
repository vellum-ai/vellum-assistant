/**
 * Route handler for the conversation attention API.
 * Exposes attention state (seen/unseen) for conversations,
 * useful for assistant/LLM reporting and UI indicators.
 */

import { z } from "zod";

import {
  type AttentionFilterState,
  listConversationAttention,
} from "../../memory/conversation-attention-store.js";
import {
  getConversation,
  getMessageById,
} from "../../memory/conversation-crud.js";
import { truncate } from "../../util/truncate.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function handleListConversationAttention(url: URL): Response {
  const stateParam = url.searchParams.get("state") ?? "all";
  const sourceParam = url.searchParams.get("source") ?? "all";
  const channel = url.searchParams.get("channel") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 20;
  const beforeParam = url.searchParams.get("before");
  const rawBefore = beforeParam ? Number(beforeParam) : undefined;
  const before =
    rawBefore !== undefined && Number.isFinite(rawBefore)
      ? rawBefore
      : undefined;

  if (!["seen", "unseen", "all"].includes(stateParam)) {
    return httpError(
      "BAD_REQUEST",
      "Invalid state parameter. Must be seen, unseen, or all.",
      400,
    );
  }

  const attentionStates = listConversationAttention({
    state: stateParam as AttentionFilterState,
    sourceChannel: channel,
    source: sourceParam !== "all" ? sourceParam : undefined,
    limit: limit + 1, // fetch one extra to determine hasMore
    before,
  });

  const hasMore = attentionStates.length > limit;
  const pageStates = hasMore
    ? attentionStates.slice(0, limit)
    : attentionStates;

  // Batch-fetch conversation metadata for title enrichment
  const conversationIds = pageStates.map((s) => s.conversationId);
  const conversationMap = new Map<
    string,
    { title: string | null; source: string }
  >();
  for (const id of conversationIds) {
    const conv = getConversation(id);
    if (conv) {
      conversationMap.set(id, {
        title: conv.title,
        source: conv.source ?? "user",
      });
    }
  }

  // Batch-fetch latest assistant message snippets
  const snippetMap = new Map<string, string>();
  for (const attn of pageStates) {
    if (attn.latestAssistantMessageId) {
      const msg = getMessageById(attn.latestAssistantMessageId);
      if (msg?.content) {
        snippetMap.set(
          attn.latestAssistantMessageId,
          truncate(msg.content, 200, ""),
        );
      }
    }
  }

  const results = pageStates.map((attn) => {
    const conv = conversationMap.get(attn.conversationId);
    const convSource = conv?.source ?? "user";
    const hasUnseen =
      attn.latestAssistantMessageAt != null &&
      (attn.lastSeenAssistantMessageAt == null ||
        attn.lastSeenAssistantMessageAt < attn.latestAssistantMessageAt);
    const state: "seen" | "unseen" | "no_assistant_message" =
      attn.latestAssistantMessageAt == null
        ? "no_assistant_message"
        : hasUnseen
          ? "unseen"
          : "seen";

    const snippet = attn.latestAssistantMessageId
      ? (snippetMap.get(attn.latestAssistantMessageId) ?? null)
      : null;

    return {
      conversationId: attn.conversationId,
      title: conv?.title ?? null,
      source: convSource,
      state,
      latestAssistantMessageAt: attn.latestAssistantMessageAt,
      latestAssistantSnippet: snippet,
      lastSeenAssistantMessageAt: attn.lastSeenAssistantMessageAt,
      lastSeenEventAt: attn.lastSeenEventAt,
      lastSeenConfidence: attn.lastSeenConfidence,
      lastSeenSignalType: attn.lastSeenSignalType,
      lastSeenSourceChannel: attn.lastSeenSourceChannel,
      lastSeenSource: attn.lastSeenSource,
      lastSeenEvidenceText: attn.lastSeenEvidenceText
        ? truncate(attn.lastSeenEvidenceText, 200, "")
        : null,
    };
  });

  return Response.json({
    conversations: results,
    hasMore,
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationAttentionRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/attention",
      method: "GET",
      summary: "List conversation attention states",
      description:
        "Return attention state (seen/unseen) for conversations, with pagination.",
      tags: ["conversations"],
      queryParams: [
        {
          name: "state",
          schema: { type: "string" },
          description: "Filter: seen, unseen, or all (default all)",
        },
        {
          name: "source",
          schema: { type: "string" },
          description: "Filter by source (default all)",
        },
        {
          name: "channel",
          schema: { type: "string" },
          description: "Filter by source channel",
        },
        {
          name: "limit",
          schema: { type: "integer" },
          description: "Max results (1–100, default 20)",
        },
        {
          name: "before",
          schema: { type: "number" },
          description: "Cursor for pagination (timestamp)",
        },
      ],
      responseBody: z.object({
        conversations: z.array(z.unknown()).describe("Attention state objects"),
        hasMore: z.boolean(),
      }),
      handler: ({ url }) => handleListConversationAttention(url),
    },
  ];
}
