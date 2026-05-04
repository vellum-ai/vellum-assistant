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
 * Client registration:
 *   Clients may send `X-Vellum-Client-Id` and `X-Vellum-Interface-Id`
 *   request headers. When both are present, the subscriber is registered
 *   as a client in the event hub with derived capabilities. The hub
 *   handles registration, touch (heartbeat), and unregistration (dispose).
 */

import type { HostProxyCapability } from "../../channels/types.js";
import { parseInterfaceId, supportsHostProxy } from "../../channels/types.js";
import { getOrCreateConversation } from "../../memory/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import {
  formatSseFrame,
  formatSseHeartbeatWithData,
} from "../assistant-event.js";
import type {
  AssistantEventCallback,
  AssistantEventFilter,
  AssistantEventSubscription,
} from "../assistant-event-hub.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../assistant-event-hub.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("events-routes");

/** Keep-alive comment sent to idle clients every 5 s by default. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

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
 *   When both are present, the subscriber is registered as a client in the
 *   event hub with metadata (interfaceId, capabilities). The hub handles
 *   lifecycle — dispose() unregisters the client automatically.
 *
 * Options (for testing):
 *   hub               -- override the event hub (defaults to process singleton).
 *   heartbeatIntervalMs -- how often to emit keep-alive comments (default 5 s).
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

  // ── Client identity from headers ──────────────────────────────────────
  const rawClientId = headers?.["x-vellum-client-id"];
  const rawInterfaceId = headers?.["x-vellum-interface-id"];
  const rawMachineName = headers?.["x-vellum-machine-name"];
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

  const hub = options?.hub ?? assistantEventHub;
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const ALL_CAPABILITIES: HostProxyCapability[] = [
    "host_bash",
    "host_file",
    "host_cu",
    "host_app_control",
    "host_browser",
  ];

  const filter: AssistantEventFilter = {};
  if (conversationKey) {
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
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  }

  const callback: AssistantEventCallback = (event) => {
    const controller = controllerRef;
    if (!controller) return;
    try {
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
  };

  try {
    const subscriberBase = {
      filter,
      callback,
      onEvict: cleanup,
    };

    sub =
      clientId && interfaceId
        ? hub.subscribe({
            ...subscriberBase,
            type: "client" as const,
            clientId,
            interfaceId,
            capabilities: ALL_CAPABILITIES.filter((cap) =>
              supportsHostProxy(interfaceId, cap),
            ),
            machineName: rawMachineName?.trim() || undefined,
          })
        : hub.subscribe({
            ...subscriberBase,
            type: "process" as const,
          });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ServiceUnavailableError("Too many concurrent connections");
    }
    throw err;
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;

        if (abortSignal?.aborted) {
          sub.dispose();
          cleanup();
          return;
        }

        controller.enqueue(encoder.encode(formatSseHeartbeatWithData()));

        heartbeatTimer = setInterval(() => {
          try {
            if (controller.desiredSize != null && controller.desiredSize <= 0) {
              sub.dispose();
              cleanup();
              return;
            }
            if (clientId) {
              hub.touchClient(clientId);
            }
            controller.enqueue(encoder.encode(formatSseHeartbeatWithData()));
          } catch {
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
