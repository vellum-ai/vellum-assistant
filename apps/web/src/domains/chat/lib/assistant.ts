/**
 * Assistant-level operations: discovery, chat context bootstrapping,
 * and runtime identity retrieval.
 */

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/chat/lib/client.js";
import {
  isBackgroundConversation,
  listConversations,
} from "@/domains/chat/lib/conversations.js";
import type { Conversation } from "@/domains/chat/lib/conversations.js";

async function fetchAssistantId(): Promise<string | null> {
  // Prefer platform-managed assistants, fall back to local.
  // Query separately to avoid pagination issues with hosting=all.
  for (const hosting of ["platform", "local"] as const) {
    const { data, error, response } = await client.get<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/",
      query: { hosting },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch assistants");
    if (!response.ok) {
      const msg = extractErrorMessage(error, response, "Failed to fetch assistants");
      throw new ApiError(response.status, msg);
    }

    const assistantsRaw =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { results?: unknown }).results
        : undefined;

    const assistants: Array<{ id: string; created: string }> = Array.isArray(assistantsRaw)
      ? assistantsRaw.filter(
        (assistant): assistant is { id: string; created: string } =>
          !!assistant &&
          typeof assistant === "object" &&
          typeof (assistant as { id?: unknown }).id === "string" &&
          typeof (assistant as { created?: unknown }).created === "string",
      )
      : [];

    if (assistants.length > 0) {
      assistants.sort(
        (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
      );
      return assistants[0]!.id;
    }
  }

  return null;
}

export interface ChatContext {
  assistantId: string;
  conversations: Conversation[];
  conversationKey: string;
}

/**
 * Build the chat context by fetching the assistant and listing its
 * conversations.  The returned `conversationKey` defaults to the latest
 * conversation; callers may override it (e.g. from a query-param).
 */
export async function getChatContext(): Promise<ChatContext | null> {
  const assistantId = await fetchAssistantId();
  if (!assistantId) {
    return null;
  }

  const conversations = await listConversations(assistantId);
  const active = conversations.filter((c) => c.archivedAt == null);
  // Prefer a foreground conversation as the default landing conversation.
  // Background/scheduled conversations live behind a collapsed-by-default
  // sidebar section and must never be selected implicitly. If only background
  // conversations exist, use the assistant id as a fresh standard-chat key.
  const latestForeground = active.find((c) => !isBackgroundConversation(c));
  const conversationKey = latestForeground
    ? latestForeground.conversationKey
    : assistantId;

  return { assistantId, conversations, conversationKey };
}

// ---------------------------------------------------------------------------
// Runtime identity
// ---------------------------------------------------------------------------

export interface AssistantIdentity {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
  version: string;
  createdAt?: string;
}

/**
 * Fetch the runtime identity for an assistant via the wildcard proxy.
 * Returns `null` when the identity cannot be retrieved (e.g. assistant
 * is still initializing or the runtime is unreachable).
 */
export async function fetchAssistantIdentity(
  assistantId: string,
): Promise<AssistantIdentity | null> {
  try {
    const { data, error, response } = await client.get<AssistantIdentity, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/identity/",
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch assistant identity");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
