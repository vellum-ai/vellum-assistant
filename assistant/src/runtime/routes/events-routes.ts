/**
 * Route handler for the assistant-events SSE endpoint.
 *
 * GET /v1/events?conversationKey=...
 * GET /v1/assistants/:assistantId/events?conversationKey=...  (legacy)
 *
 * Auth is enforced by RuntimeHttpServer before this handler is called.
 * Subscribers receive all assistant events scoped to the given conversation.
 */

import { getOrCreateConversation } from '../../memory/conversation-key-store.js';
import { assistantEventHub } from '../assistant-event-hub.js';
import { formatSseFrame } from '../assistant-event.js';
import type { AssistantEventSubscription } from '../assistant-event-hub.js';

/**
 * Stream assistant events as Server-Sent Events for a specific conversation.
 *
 * The assistantId is extracted from the legacy `/v1/assistants/:id/events`
 * path when present; otherwise defaults to `'self'` (the current single-
 * assistant runtime default used by all other routes).
 *
 * Query params:
 *   conversationKey — required; scopes the stream to one conversation.
 */
export function handleSubscribeAssistantEvents(
  req: Request,
  url: URL,
): Response {
  const conversationKey = url.searchParams.get('conversationKey');
  if (!conversationKey) {
    return Response.json({ error: 'conversationKey is required' }, { status: 400 });
  }

  // Extract the assistantId from the legacy /v1/assistants/:id/events path
  // (falls back to 'self' for the new /v1/events route).  The current
  // single-tenant runtime publishes all events under 'self', so reject any
  // other value explicitly — a non-'self' ID would produce a silently empty
  // stream rather than the expected events.
  const pathMatch = url.pathname.match(/^\/v1\/assistants\/([^/]+)\/events$/);
  const assistantId = pathMatch?.[1] ?? 'self';
  if (assistantId !== 'self') {
    return Response.json(
      { error: `Assistant ID '${assistantId}' is not supported; use 'self'` },
      { status: 400 },
    );
  }

  const mapping = getOrCreateConversation('self', conversationKey);
  const encoder = new TextEncoder();
  let sub: AssistantEventSubscription | null = null;

  const stream = new ReadableStream({
    start(controller) {
      sub = assistantEventHub.subscribe(
        { assistantId: 'self', sessionId: mapping.conversationId },
        (event) => {
          try {
            controller.enqueue(encoder.encode(formatSseFrame(event)));
          } catch {
            sub?.dispose();
          }
        },
      );

      req.signal.addEventListener('abort', () => {
        sub?.dispose();
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      sub?.dispose();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
