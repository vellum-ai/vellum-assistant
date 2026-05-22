import { client } from "@/generated/api/client.gen.js";

// `/v1/assistants/{id}/suggestion` is not yet in the OpenAPI schema, so we
// fall through to the low-level HeyAPI client until it's generated.
const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export interface SuggestionResult {
  suggestion: string | null;
  messageId: string | null;
  source: "llm" | "none";
}

const EMPTY: SuggestionResult = {
  suggestion: null,
  messageId: null,
  source: "none",
};

export async function fetchSuggestion(
  assistantId: string,
  conversationKey: string,
  messageId?: string,
  signal?: AbortSignal,
): Promise<SuggestionResult> {
  try {
    const { data, response } = await client.get<SuggestionResult, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/suggestion",
      path: { assistant_id: assistantId },
      query: {
        conversationId: conversationKey,
        conversationKey,
        ...(messageId ? { messageId } : {}),
      },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok) return EMPTY;
    return data as SuggestionResult;
  } catch {
    return EMPTY;
  }
}
