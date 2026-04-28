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
 *
 * If the conversationKey has no server-side mapping yet (e.g. a client-
 * generated draft UUID that has not been sent a first message), this
 * handler eagerly materialises the conversation so the subscriber's
 * `filter.conversationId` matches the id under which the first turn's
 * scoped events (text deltas, tool calls, message_complete) will be
 * published by `handleSendMessage`. The `conversation_list_invalidated`
 * notification for other clients is driven by `handleSendMessage`'s
 * first-message check, so eager materialisation here is safe and does
 * not hide the first-message notification from other clients.
 *
 * Client registration:
 *   Clients may send `X-Vellum-Client-Id` and `X-Vellum-Interface-Id`
 *   request headers to register in the ClientRegistry on connect and
 *   automatically unregister on disconnect. When both headers are present,
 *   the client is registered immediately, touched on each heartbeat, and
 *   unregistered when the stream closes. When either header is missing,
 *   registration is skipped (backwards compat).
 */

import { parseInterfaceId } from "../../channels/types.js";
import { getOrCreateConversation } from "../../memory/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import { formatSseFrame, formatSseHeartbeat } from "../assistant-event.js";
import type {
  AssistantEventFilter,
  AssistantEventSubscription,
} from "../assistant-event-hub.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../assistant-event-hub.js";
import { getClientRegistry } from "../client-registry.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("events-routes");

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
 * Headers (optional):
 *   X-Vellum-Client-Id    -- stable per-install UUID identifying this client.
 *   X-Vellum-Interface-Id -- interface type (e.g. "macos", "ios", "web").
 *
 *   When both are present the client is registered in the ClientRegistry on
 *   connect and unregistered on disconnect.
 *
 * Options (for testing):
 *   hub               -- override the event hub (defaults to process singleton).
 *   heartbeatIntervalMs -- how often to emit keep-alive comments (default 30 s).
 */
export function handleSubscribeAssistantEvents(
  args: RouteHandlerArgs,
  options?: {
    hub?: AssistantEventHub;
    heartbeatIntervalMs?: number;
  },
): ReadableStream<Uint8Array> {
  const { queryParams, headers, abortSignal } = args;

  const conversationKey = queryParams?.conversationKey;
  if ("conversationKey" in (queryParams ?? {}) && !conversationKey?.trim()) {
    throw new BadRequestError("conversationKey must not be empty");
  }

  // ── Client registration from headers ──────────────────────────────────
  const rawClientId = headers?.["x-vellum-client-id"];
  const rawInterfaceId = headers?.["x-vellum-interface-id"];
  const clientId = rawClientId?.trim() || null;
  const interfaceId = clientId
    ? parseInterfaceId(rawInterfaceId?.trim())
    : null;

  if (clientId && !interfaceId) {
    log.error(
      { clientId, rawInterfaceId },
      "client registration failed: invalid or missing X-Vellum-Interface-Id",
    );
    throw new BadRequestError(
      "X-Vellum-Interface-Id is required when X-Vellum-Client-Id is provided",
    );
  }

  const registry = getClientRegistry();
  if (clientId && interfaceId) {
    registry.register({ clientId, interfaceId });
    log.info(
      { clientId, interfaceId },
      "client registered via /events SSE connect",
    );
  }

  const hub = options?.hub ?? assistantEventHub;
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const filter: AssistantEventFilter = {};
  if (conversationKey) {
    // Eagerly resolve (and if necessary create) the conversation so the
    // subscriber's filter matches the id under which first-turn scoped
    // events will be published. The `conversation_list_invalidated`
    // publish is driven by `handleSendMessage`'s first-message check,
    // so eager materialisation here is safe and does not suppress the
    // cross-client notification.
    const mapping = getOrCreateConversation(conversationKey);
    filter.conversationId = mapping.conversationId;
  }
  const encoder = new TextEncoder();

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
    if (clientId) {
      registry.unregister(clientId);
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
      if (clientId) {
        registry.unregister(clientId);
      }
      throw new ServiceUnavailableError("Too many concurrent connections");
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
        if (abortSignal?.aborted) {
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
            // Touch the client on each heartbeat to keep it fresh in the
            // registry. Without this, long-idle SSE connections would be
            // evicted by the staleness sweep despite being connected.
            if (clientId) {
              registry.touch(clientId);
            }
            controller.enqueue(encoder.encode(formatSseHeartbeat()));
          } catch {
            // Controller already closed (e.g. client disconnected).
            sub.dispose();
            cleanup();
          }
        }, heartbeatIntervalMs);

        abortSignal?.addEventListener(
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

  return stream;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "subscribe_assistant_events",
    endpoint: "events",
    method: "GET",
    summary: "Subscribe to assistant events",
    description: "Stream assistant events as Server-Sent Events (SSE).",
    tags: ["events"],
    queryParams: [
      {
        name: "conversationKey",
        description: "Scope to a single conversation",
      },
    ],
    responseHeaders: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    handler: (args) => handleSubscribeAssistantEvents(args),
  },
];
