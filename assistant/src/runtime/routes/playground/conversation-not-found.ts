/**
 * Body code for "conversation lookup returned no row" 404s on
 * conversation-scoped playground routes. Distinct from the generic
 * `NOT_FOUND` code (and from `playground_disabled`, see `guard.ts`) so
 * the Swift `CompactionPlaygroundClient` can pick `.notFound` over
 * `.notAvailable` from the response body rather than from a URL-path
 * heuristic. Without this distinction the `assertPlaygroundEnabled`
 * guard's flag-off 404 (which fires *before* the conversation lookup on
 * every conv-scoped route) would be indistinguishable from a real
 * missing-conversation 404.
 */
const CONVERSATION_NOT_FOUND_CODE = "conversation_not_found";

/**
 * Build a 404 response for a missing conversation on a playground route.
 * Uses a distinguishing body `code` so the Swift client can route this
 * to `.notFound` (rather than `.notAvailable`).
 */
export function conversationNotFoundResponse(conversationId: string): Response {
  return Response.json(
    {
      error: {
        code: CONVERSATION_NOT_FOUND_CODE,
        message: `Conversation ${conversationId} not found`,
      },
    },
    { status: 404 },
  );
}
