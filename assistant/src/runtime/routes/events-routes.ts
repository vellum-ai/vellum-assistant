/**
 * Route handler for the assistant-events SSE endpoint.
 *
 * GET /v1/events?conversationKey=...
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

  const mapping = getOrCreateConversation(conversationKey);
  const encoder = new TextEncoder();
  let sub: AssistantEventSubscription | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 'self' is the assistantId that RunOrchestrator assigns to all HTTP-run events
      // (see buildAssistantEvent('self', ...) in run-orchestrator.ts). This endpoint
      // is part of the HTTP runtime API, so only HTTP-run events are relevant here.
      // IPC/daemon events use a different assistantId ('default') and reach desktop
      // clients through a separate channel — they are intentionally excluded.
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
