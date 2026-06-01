import { suggestionGet } from "@/generated/daemon/sdk.gen";
import type { SuggestionGetResponse } from "@/generated/daemon/types.gen";
import { SDK_BASE_OPTIONS } from "@/utils/api-errors";

const EMPTY: SuggestionGetResponse = {
  suggestion: null,
  messageId: null,
  source: "none",
};

export async function fetchSuggestion(
  assistantId: string,
  conversationId: string,
  messageId?: string,
  signal?: AbortSignal,
): Promise<SuggestionGetResponse> {
  try {
    const { data, response } = await suggestionGet({
      ...SDK_BASE_OPTIONS,
      path: { assistant_id: assistantId },
      query: {
        conversationId,
        ...(messageId ? { messageId } : {}),
      },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok || !data) return EMPTY;
    return data;
  } catch {
    return EMPTY;
  }
}
