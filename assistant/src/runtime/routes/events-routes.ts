/**
 * Route handler for the assistant-events SSE endpoint.
 *
 * GET /v1/events?conversationKey=...
 *
 * Auth is enforced by RuntimeHttpServer before this handler is called.
 * Subscribers receive all assistant events scoped to the given conversation.
 */

import { getOrCreateConversation } from '../../memory/conversation-key-store.js';
import { assistantEventHub, AssistantEventHub } from '../assistant-event-hub.js';
import { formatSseFrame, formatSseHeartbeat } from '../assistant-event.js';
import type { AssistantEventSubscription } from '../assistant-event-hub.js';

/** Keep-alive comment sent to idle clients every 30 s by default. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Stream assistant events as Server-Sent Events for a specific conversation.
 *
 * Query params:
 *   conversationKey — required; scopes the stream to one conversation.
 *
 * Options (for testing):
 *   hub               — override the event hub (defaults to process singleton).
 *   heartbeatIntervalMs — how often to emit keep-alive comments (default 30 s).
 */
export function handleSubscribeAssistantEvents(
  req: Request,
  url: URL,
  options?: {
    hub?: AssistantEventHub;
    heartbeatIntervalMs?: number;
  },
): Response {
  const conversationKey = url.searchParams.get('conversationKey');
  if (!conversationKey) {
    return Response.json({ error: 'conversationKey is required' }, { status: 400 });
  }

  const hub = options?.hub ?? assistantEventHub;
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const mapping = getOrCreateConversation(conversationKey);
  const encoder = new TextEncoder();

  // ── Eager subscribe ──────────────────────────────────────────────────────
  // Subscribe before creating the ReadableStream so that a hub capacity error
  // produces a 503 rather than a mid-stream failure.  The callback references
  // `controllerRef` (set synchronously in start()) via closure — this is safe
  // because events are only published asynchronously after this call returns.
  // 'self' is the assistantId that RunOrchestrator assigns to all HTTP-run
  // events (see buildAssistantEvent('self', ...) in run-orchestrator.ts).
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sub!: AssistantEventSubscription;

  try {
    sub = hub.subscribe(
      { assistantId: 'self', sessionId: mapping.conversationId },
      (event) => {
        const controller = controllerRef;
        if (!controller) return;
        try {
          // Shed stalled consumers: desiredSize <= 0 means the 16-event buffer
          // is full and the client isn't draining it.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            sub.dispose();
            if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
            try { controller.close(); } catch { /* already closed */ }
            return;
          }
          controller.enqueue(encoder.encode(formatSseFrame(event)));
        } catch {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    if (err instanceof RangeError) {
      return Response.json({ error: 'Too many concurrent connections' }, { status: 503 });
    }
    throw err;
  }

  // Allow up to 16 queued frames before treating the consumer as stalled.
  // This absorbs normal token-stream bursts without prematurely closing the
  // connection, while still shedding genuinely slow clients.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      // Send a keep-alive comment on each interval to prevent proxies and
      // load-balancers from treating idle connections as timed out.
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(formatSseHeartbeat()));
        } catch {
          // Controller already closed (e.g. client disconnected).
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        }
      }, heartbeatIntervalMs);

      req.signal.addEventListener('abort', () => {
        sub.dispose();
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      sub.dispose();
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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
