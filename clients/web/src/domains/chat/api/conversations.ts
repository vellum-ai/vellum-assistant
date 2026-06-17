import { conversationsByIdSurfacePost } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export async function surfaceConversation(
  assistantId: string,
  conversationId: string,
): Promise<number> {
  const { data, error, response } = await conversationsByIdSurfacePost({
    path: { assistant_id: assistantId, id: conversationId },
    body: { surfaced: true },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to surface conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to surface conversation.",
    );
    throw new ApiError(response.status, msg);
  }
  if (typeof data?.surfacedAt !== "number") {
    const bodyPreview = JSON.stringify(data ?? null).slice(0, 200);
    throw new ApiError(
      response.status,
      `Surface conversation payload was malformed (status=${response.status}, body=${bodyPreview}).`,
    );
  }
  return data.surfacedAt;
}
