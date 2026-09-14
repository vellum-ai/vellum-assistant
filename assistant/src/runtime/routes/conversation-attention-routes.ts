/**
 * Route handler for the conversation attention API.
 * Exposes attention state (seen/unseen) for conversations,
 * useful for assistant/LLM reporting and UI indicators.
 */

import { z } from "zod";

import {
  type AttentionFilterState,
  listConversationAttention,
} from "../../persistence/conversation-attention-store.js";
import {
  getAssistantMessageIdsInTurn,
  getConversation,
  getMessageById,
} from "../../persistence/conversation-crud.js";
import {
  isPrivateAssistantText,
  userFacingTextOfRow,
} from "../../persistence/user-facing-content.js";
import { truncate } from "../../util/truncate.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const SNIPPET_CHARS = 200;

/**
 * The words a conversation's latest assistant row leaves in this preview.
 *
 * Read through the user-facing projection rather than off the row: on a turn
 * that routed its reply through `send_user_message` the row's plain text is a
 * private scratchpad and the reply lives inside the tool call, so anything
 * that serializes the row itself puts the scratchpad on this wire.
 *
 * A gated turn usually ends on wrap-up notes that project to nothing, so an
 * empty private row walks back through its own turn to the row carrying the
 * delivered message, the same way the schedule-result notification does. The
 * walk stops at the first row that is not private: an ordinary turn is read
 * from its latest row alone, exactly as before.
 */
export function resolveAssistantSnippet(messageId: string): string | null {
  let ids: string[];
  try {
    ids = getAssistantMessageIdsInTurn(messageId);
  } catch {
    ids = [messageId];
  }
  // Newest first, starting at the row attention actually points at.
  const anchorIndex = ids.lastIndexOf(messageId);
  const ordered =
    anchorIndex === -1 ? [messageId] : ids.slice(0, anchorIndex + 1);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const row = getMessageById(ordered[i]);
    if (!row?.content) {
      continue;
    }
    const text = userFacingTextOfRow(row.content, row.metadata).trim();
    if (text.length > 0) {
      return truncate(text, SNIPPET_CHARS, "");
    }
    if (!isPrivateAssistantText(row.metadata)) {
      return null;
    }
  }
  return null;
}

function handleListConversationAttention({
  queryParams = {},
}: RouteHandlerArgs) {
  const stateParam = queryParams.state ?? "all";
  const sourceParam = queryParams.source ?? "all";
  const channel = queryParams.channel ?? undefined;
  const rawLimit = Number(queryParams.limit ?? 20);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 20;
  const rawBefore = queryParams.before ? Number(queryParams.before) : undefined;
  const before =
    rawBefore !== undefined && Number.isFinite(rawBefore)
      ? rawBefore
      : undefined;

  if (!["seen", "unseen", "all"].includes(stateParam)) {
    throw new BadRequestError(
      "Invalid state parameter. Must be seen, unseen, or all.",
    );
  }

  const attentionStates = listConversationAttention({
    state: stateParam as AttentionFilterState,
    sourceChannel: channel,
    source: sourceParam !== "all" ? sourceParam : undefined,
    limit: limit + 1,
    before,
  });

  const hasMore = attentionStates.length > limit;
  const pageStates = hasMore
    ? attentionStates.slice(0, limit)
    : attentionStates;

  const conversationMap = new Map<
    string,
    { title: string | null; source: string }
  >();
  for (const id of pageStates.map((s) => s.conversationId)) {
    const conv = getConversation(id);
    if (conv) {
      conversationMap.set(id, {
        title: conv.title,
        source: conv.source ?? "user",
      });
    }
  }

  const snippetMap = new Map<string, string>();
  for (const attn of pageStates) {
    if (attn.latestAssistantMessageId) {
      const snippet = resolveAssistantSnippet(attn.latestAssistantMessageId);
      if (snippet !== null) {
        snippetMap.set(attn.latestAssistantMessageId, snippet);
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

  return {
    conversations: results,
    hasMore,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversations_attention_list",
    endpoint: "conversations/attention",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListConversationAttention,
    summary: "List conversation attention states",
    description:
      "Return attention state (seen/unseen) for conversations, with pagination.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "state",
        description: "Filter: seen, unseen, or all (default all)",
      },
      {
        name: "source",
        description: "Filter by source (default all)",
      },
      {
        name: "channel",
        description: "Filter by source channel",
      },
      {
        name: "limit",
        type: "integer",
        description: "Max results (1–100, default 20)",
      },
      {
        name: "before",
        type: "number",
        description: "Cursor for pagination (timestamp)",
      },
    ],
    responseBody: z.object({
      conversations: z.array(z.unknown()).describe("Attention state objects"),
      hasMore: z.boolean(),
    }),
  },
];
