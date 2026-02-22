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
import { getLogger } from '../../util/logger.js';

const log = getLogger('events-routes');

/** SSE heartbeat interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 15_000;

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
  log.info(
    { conversationKey, conversationId: mapping.conversationId },
    'SSE subscription created',
  );
  const encoder = new TextEncoder();
  let sub: AssistantEventSubscription | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Allow up to 16 queued frames before treating the consumer as stalled.
  // This absorbs normal token-stream bursts without prematurely closing the
  // connection, while still shedding genuinely slow clients.
  const stream = new ReadableStream({
    start(controller) {
      // Send an initial connection comment immediately. This primes the
      // HTTP response body so proxies (including the gateway's Bun-based
      // runtime proxy) begin streaming data to downstream clients.
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Periodic heartbeats keep the connection alive and help flush
      // any intermediate proxy buffers (e.g., Bun's chunked-transfer
      // buffering over loopback connections).
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // Stream closed — clean up in cancel()
        }
      }, HEARTBEAT_INTERVAL_MS);

      // 'self' is the assistantId that RunOrchestrator assigns to all HTTP-run events
      // (see buildAssistantEvent('self', ...) in run-orchestrator.ts). This endpoint
      // is part of the HTTP runtime API, so only HTTP-run events are relevant here.
      // IPC/daemon events use a different assistantId ('default') and reach desktop
      // clients through a separate channel — they are intentionally excluded.
      sub = assistantEventHub.subscribe(
        { assistantId: 'self', sessionId: mapping.conversationId },
        (event) => {
          try {
            // Shed stalled consumers: desiredSize <= 0 means the 16-event buffer
            // is full and the client isn't draining it.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              log.warn({ conversationKey }, 'SSE consumer stalled, disposing subscription');
              sub?.dispose();
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              try { controller.close(); } catch { /* already closed */ }
              return;
            }
            const msgType = (event.message as { type?: string }).type ?? 'unknown';
            log.info({ conversationKey, msgType }, 'SSE event enqueued');
            controller.enqueue(encoder.encode(formatSseFrame(event)));
          } catch {
            sub?.dispose();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        },
      );

      req.signal.addEventListener('abort', () => {
        log.info({ conversationKey }, 'SSE connection aborted by client');
        sub?.dispose();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      sub?.dispose();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  }, new CountQueuingStrategy({ highWaterMark: 16 }));

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
