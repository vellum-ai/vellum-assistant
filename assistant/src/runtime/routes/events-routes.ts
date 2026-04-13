/**
 * Route handler for the assistant-events SSE endpoint.
 *
 * GET /v1/events?conversationKey=...
 *
 * JWT bearer auth is enforced by RuntimeHttpServer before this handler
 * is called. The AuthContext is threaded through from the HTTP server
 * layer, so no additional actor-token verification is needed here.
 *
 * When `conversationKey` is provided, subscribers receive events scoped to
 * that conversation. When omitted, subscribers receive events from ALL
 * conversations for this assistant (unfiltered).
 */

import { getOrCreateConversation } from "../../memory/conversation-key-store.js";
import { formatSseFrame, formatSseHeartbeat } from "../assistant-event.js";
import type {
  AssistantEventFilter,
  AssistantEventSubscription,
} from "../assistant-event-hub.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

/** Keep-alive comment sent to idle clients every 30 s by default. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Stream assistant events as Server-Sent Events.
 *
 * Query params:
 *   conversationKey -- optional; when provided, scopes the stream to one
 *                      conversation. When omitted, the stream delivers events
 *                      from ALL conversations for this assistant.
 *
 * Options (for testing):
 *   hub               -- override the event hub (defaults to process singleton).
 *   heartbeatIntervalMs -- how often to emit keep-alive comments (default 30 s).
 */
export function handleSubscribeAssistantEvents(
  req: Request,
  url: URL,
  options?:
    | {
        hub?: AssistantEventHub;
        heartbeatIntervalMs?: number;
        authContext: AuthContext;
      }
    | {
        hub?: AssistantEventHub;
        heartbeatIntervalMs?: number;
        skipActorVerification: true;
      },
): Response {
  // Auth is already verified upstream by JWT middleware. The AuthContext
  // is available via options.authContext but we don't need to check it
  // further here -- the route policy in http-server.ts already enforced
  // scope and principal type requirements.

  const conversationKey = url.searchParams.get("conversationKey");
  if (url.searchParams.has("conversationKey") && !conversationKey?.trim()) {
    return httpError("BAD_REQUEST", "conversationKey must not be empty", 400);
  }

  const hub = options?.hub ?? assistantEventHub;
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const filter: AssistantEventFilter = {
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
  };
  if (conversationKey) {
    const mapping = getOrCreateConversation(conversationKey);
    filter.conversationId = mapping.conversationId;
  }
  const encoder = new TextEncoder();

  // -- Replay buffered events for Last-Event-ID reconnects --------------------
  const lastEventId = req.headers.get("Last-Event-ID");
  let replayEvents: ReturnType<AssistantEventHub["getEventsSince"]> = [];
  if (lastEventId && filter.conversationId) {
    replayEvents = hub.getEventsSince(filter.conversationId, lastEventId);
  }

  // -- Eager subscribe --------------------------------------------------------
  // Subscribe before creating the ReadableStream so the callback and onEvict
  // closures are in place before events can arrive.  `controllerRef` is set
  // synchronously inside ReadableStream's start(), so it is non-null by the
  // time any event or eviction fires.
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sub!: AssistantEventSubscription;

  function cleanup() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  }

  try {
    sub = hub.subscribe(
      filter,
      (event) => {
        const controller = controllerRef;
        if (!controller) return;
        try {
          // Shed stalled consumers: desiredSize <= 0 means the 16-event buffer
          // is full and the client isn't draining it.
          if (controller.desiredSize != null && controller.desiredSize <= 0) {
            sub.dispose();
            cleanup();
            return;
          }
          controller.enqueue(encoder.encode(formatSseFrame(event)));
        } catch {
          sub.dispose();
          cleanup();
        }
      },
      {
        // Called by the hub when a newer connection evicts this one (capacity
        // management: oldest subscriber out, newest in).
        onEvict: cleanup,
      },
    );
  } catch (err) {
    if (err instanceof RangeError) {
      return httpError(
        "SERVICE_UNAVAILABLE",
        "Too many concurrent connections",
        503,
      );
    }
    throw err;
  }

  // Allow up to 16 queued frames before treating the consumer as stalled.
  // This absorbs normal token-stream bursts without prematurely closing the
  // connection, while still shedding genuinely slow clients.
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;

        // If the client already disconnected before start() ran, clean up
        // immediately -- the abort event fires once and won't be re-dispatched.
        if (req.signal.aborted) {
          sub.dispose();
          cleanup();
          return;
        }

        // Immediately enqueue a heartbeat comment so the HTTP status line and
        // headers are flushed to the client without waiting for a real event.
        // Without this, Bun may buffer the headers until the first data chunk
        // arrives, causing clients (e.g. Python `requests`) to hang until the
        // periodic heartbeat fires or an event is published.
        controller.enqueue(encoder.encode(formatSseHeartbeat()));

        // Replay buffered events that arrived between the client's last
        // checkpoint and now, before live events start flowing.
        for (const evt of replayEvents) {
          controller.enqueue(encoder.encode(formatSseFrame(evt)));
        }

        // Send a keep-alive comment on each interval to prevent proxies and
        // load-balancers from treating idle connections as timed out.
        heartbeatTimer = setInterval(() => {
          try {
            // Apply the same slow-consumer guard as the event path: stop
            // feeding heartbeats into a queue the client is not draining.
            if (controller.desiredSize != null && controller.desiredSize <= 0) {
              sub.dispose();
              cleanup();
              return;
            }
            controller.enqueue(encoder.encode(formatSseHeartbeat()));
          } catch {
            // Controller already closed (e.g. client disconnected).
            sub.dispose();
            cleanup();
          }
        }, heartbeatIntervalMs);

        req.signal.addEventListener(
          "abort",
          () => {
            sub.dispose();
            cleanup();
          },
          { once: true },
        );
      },
      cancel() {
        sub.dispose();
        cleanup();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 16 }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function eventsRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "events",
      method: "GET",
      summary: "Subscribe to assistant events",
      description: "Stream assistant events as Server-Sent Events (SSE).",
      tags: ["events"],
      queryParams: [
        {
          name: "conversationKey",
          schema: { type: "string" },
          description: "Scope to a single conversation",
        },
      ],
      handler: ({ req, url, authContext }) =>
        handleSubscribeAssistantEvents(req, url, { authContext }),
    },
  ];
}
