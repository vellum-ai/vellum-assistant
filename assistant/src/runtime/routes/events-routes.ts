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

import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";

import { z } from "zod";

import type { HostProxyCapability } from "../../channels/types.js";
import { parseInterfaceId, supportsHostProxy } from "../../channels/types.js";
import { notifyContactsChanged } from "../../contacts/notify-contacts-changed.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { getOrCreateConversation } from "../../persistence/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import { formatSseFrame, formatSseHeartbeat } from "../assistant-event.js";
import type {
  AssistantEventCallback,
  AssistantEventFilter,
  AssistantEventSubscription,
} from "../assistant-event-hub.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../assistant-event-hub.js";
import type { ReplaySubscriber } from "../assistant-stream-state.js";
import { getReplayWindow } from "../assistant-stream-state.js";
import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../client-health.js";
import { resolveActorPrincipalIdForLocalGuardianSync } from "../local-actor-identity.js";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("events-routes");

const ALL_CAPABILITIES: HostProxyCapability[] = [
  "host_bash",
  "host_file",
  "host_cu",
  "host_app_control",
  "host_browser",
];

/**
 * Resolution of the event-loop delay histogram, per
 * https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions.
 * A 20 ms resolution gives sub-tick visibility while keeping overhead near zero.
 */
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

/**
 * How often we reset the cumulative event-loop delay histogram so subsequent
 * percentile snapshots reflect recent behavior rather than the entire process
 * lifetime. Matches the default window used by `@fastify/under-pressure` and
 * `prom-client` for runtime-pressure metrics.
 */
const EVENT_LOOP_DELAY_RESET_INTERVAL_MS = 60_000;

let eventLoopDelay: IntervalHistogram | null = null;
let eventLoopResetTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Lazily start a cumulative event-loop delay histogram on the first SSE
 * subscriber, and schedule a periodic reset so percentile readings stay
 * meaningful across long-lived daemon processes.
 *
 * Guarded with try/catch because `node:perf_hooks.monitorEventLoopDelay`
 * was a stub in some older Bun versions; if the runtime ever regresses,
 * we still emit the shed log without lag stats rather than crashing the
 * SSE handler.
 */
function ensureEventLoopDelayMonitorStarted(): void {
  if (eventLoopDelay !== null) return;
  try {
    const histogram = monitorEventLoopDelay({
      resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
    });
    histogram.enable();
    eventLoopDelay = histogram;
    eventLoopResetTimer = setInterval(() => {
      try {
        histogram.reset();
      } catch {
        if (eventLoopResetTimer) {
          clearInterval(eventLoopResetTimer);
          eventLoopResetTimer = null;
        }
      }
    }, EVENT_LOOP_DELAY_RESET_INTERVAL_MS);
    eventLoopResetTimer.unref?.();
  } catch (err) {
    log.warn({ err }, "failed to start event-loop delay monitor");
    eventLoopDelay = null;
  }
}

export interface EventLoopDelaySnapshot {
  mean_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

function nsToMs(ns: number): number | null {
  if (!Number.isFinite(ns)) return null;
  // Round to the nearest microsecond, then express in ms (3 decimal places).
  return Math.round(ns / 1e3) / 1e3;
}

function sampleEventLoopDelay(): EventLoopDelaySnapshot {
  const histogram = eventLoopDelay;
  if (histogram === null) {
    return { mean_ms: null, p99_ms: null, max_ms: null };
  }
  try {
    return {
      mean_ms: nsToMs(histogram.mean),
      p99_ms: nsToMs(histogram.percentile(99)),
      max_ms: nsToMs(histogram.max),
    };
  } catch {
    return { mean_ms: null, p99_ms: null, max_ms: null };
  }
}

export interface SseSubscriberInstrumentation {
  subscribedAtMs: number;
  eventsDelivered: number;
  heartbeatsSent: number;
  clientId: string | null;
  interfaceId: string | null;
  conversationKey: string | null;
  /**
   * Per-connection id assigned by the hub. Distinguishes connections
   * sharing a `clientId` (old vs reconnected) so a shed can be attributed
   * to a specific connection. `null` until the hub subscription is created.
   */
  connectionId: string | null;
}

export type SseShedReason = "callback_backpressure" | "heartbeat_backpressure";

export type SseShedReporter = (
  reason: SseShedReason,
  inst: SseSubscriberInstrumentation,
) => void;

/**
 * Build the structured payload logged when an SSE subscriber is shed
 * under backpressure.
 *
 * The conversation key is deliberately excluded: for channel-backed
 * conversations (WhatsApp, Telegram, etc.) the key embeds external
 * identifiers — phone numbers, chat IDs. Correlation with the
 * client-side `sse_watchdog_fired` event is achieved via the
 * `client_id` field + timestamp instead.
 */
export function buildSseShedSentryContext(
  reason: SseShedReason,
  inst: SseSubscriberInstrumentation,
  elDelay: EventLoopDelaySnapshot,
  nowMs: number,
): Record<string, unknown> {
  return {
    reason,
    subscription_age_ms: nowMs - inst.subscribedAtMs,
    events_delivered: inst.eventsDelivered,
    heartbeats_sent: inst.heartbeatsSent,
    client_id: inst.clientId,
    interface_id: inst.interfaceId,
    connection_id: inst.connectionId,
    event_loop_delay_mean_ms: elDelay.mean_ms,
    event_loop_delay_p99_ms: elDelay.p99_ms,
    event_loop_delay_max_ms: elDelay.max_ms,
  };
}

/**
 * Report a backpressure-shed event from an SSE subscriber to logs.
 *
 * SSE subscribers are shed when `controller.desiredSize <= 0`: the consumer
 * has stopped reading and the stream's bounded queue is full. From the
 * daemon's side this looks identical to a hung client — and the visible
 * symptom on the client side is the 45 s idle-watchdog firing
 * (`sse_watchdog_fired`). Surfacing the shed lets us time-correlate
 * the two sides and attribute stalls to either backpressure or another
 * cause (network drop, event-loop starvation, etc.).
 *
 * Logged at `warn` intentionally: a shed is a saturation event, not an
 * internal error.
 */
const defaultSseShedReporter: SseShedReporter = (reason, inst) => {
  const elDelay = sampleEventLoopDelay();
  const sentryContext = buildSseShedSentryContext(
    reason,
    inst,
    elDelay,
    Date.now(),
  );
  log.warn(
    { ...sentryContext, conversation_key: inst.conversationKey },
    "sse subscriber shed under backpressure",
  );
};

/**
 * Stream assistant events as Server-Sent Events.
 *
 * Query params:
 *   conversationId  -- optional; assistant-minted internal conversation id.
 *                      When provided, the stream is scoped to that one
 *                      conversation; the daemon 404s if no such conversation
 *                      exists (clients must obtain the id from a prior
 *                      response).
 *   conversationKey -- optional; external key (non-vellum channels) or the
 *                      web idempotency key. Resolved via the conversation
 *                      keys table; materializes a row on first use.
 *                      Ignored when `conversationId` is also provided.
 *   When both are omitted, the stream delivers events from ALL
 *   conversations for this assistant.
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
 *   heartbeatIntervalMs -- how often to emit keep-alive comments (default 7 s).
 *   shedReporter      -- override the callback invoked when a subscriber is shed
 *                        under backpressure (defaults to a log line).
 */
export function handleSubscribeAssistantEvents(
  args: RouteHandlerArgs,
  options?: {
    hub?: AssistantEventHub;
    heartbeatIntervalMs?: number;
    shedReporter?: SseShedReporter;
  },
): ReadableStream<Uint8Array> {
  const { queryParams, headers, abortSignal } = args;

  const rawConversationId = queryParams?.conversationId;
  const rawConversationKey = queryParams?.conversationKey;
  const rawLastSeenSeq = queryParams?.lastSeenSeq;
  if ("conversationId" in (queryParams ?? {}) && !rawConversationId?.trim()) {
    throw new BadRequestError("conversationId must not be empty");
  }
  if ("conversationKey" in (queryParams ?? {}) && !rawConversationKey?.trim()) {
    throw new BadRequestError("conversationKey must not be empty");
  }

  // Parse the optional reconnect cursor. We accept any non-negative integer
  // -- including 0, which is the natural cursor for a client that has not
  // yet observed any event in this conversation but still wants its full
  // ring buffer replayed (as opposed to omitting the param entirely, which
  // means "no replay attempt, just connect live").
  let lastSeenSeq: number | null = null;
  if (rawLastSeenSeq != null) {
    const trimmed = rawLastSeenSeq.trim();
    if (trimmed === "") {
      throw new BadRequestError("lastSeenSeq must not be empty");
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestError("lastSeenSeq must be a non-negative integer");
    }
    lastSeenSeq = parsed;
  }

  // ── Client identity from headers ──────────────────────────────────────
  const rawClientId = headers?.["x-vellum-client-id"];
  const rawInterfaceId = headers?.["x-vellum-interface-id"];
  const rawMachineName = headers?.["x-vellum-machine-name"];
  const rawActorPrincipalId = headers?.["x-vellum-actor-principal-id"];
  const clientId = rawClientId?.trim() || null;
  const interfaceId = clientId
    ? parseInterfaceId(rawInterfaceId?.trim())
    : null;
  // Verified by RuntimeHttpServer and forwarded by the http-adapter from the
  // bearer token's AuthContext. May be absent for legacy / service-token
  // connections that have no principal. See `resolveActorPrincipalId` for the
  // dev-bypass translation rationale.
  const actorPrincipalId = resolveActorPrincipalIdForLocalGuardianSync(
    rawActorPrincipalId?.trim() || undefined,
  );

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
  const shedReporter = options?.shedReporter ?? defaultSseShedReporter;

  // Resolve the scope. `conversationId` (when supplied) is the
  // assistant-minted internal id — looked up directly; 404 if absent.
  // Otherwise fall through to `conversationKey`, which is treated as an
  // external key and resolved via the conversation_keys table
  // (materialized on first use, preserving the existing subscribe-time
  // create behavior for the web idempotency flow).
  const filter: AssistantEventFilter = {};
  let scopeConversationKey: string | null = null;
  if (rawConversationId) {
    const existing = getConversation(rawConversationId);
    if (!existing) {
      throw new NotFoundError(`Conversation ${rawConversationId} not found`);
    }
    filter.conversationId = existing.id;
    scopeConversationKey = existing.id;
  } else if (rawConversationKey) {
    const mapping = getOrCreateConversation(rawConversationKey);
    filter.conversationId = mapping.conversationId;
    scopeConversationKey = rawConversationKey;
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

  const instrumentation: SseSubscriberInstrumentation = {
    subscribedAtMs: Date.now(),
    eventsDelivered: 0,
    heartbeatsSent: 0,
    clientId,
    interfaceId,
    conversationKey: scopeConversationKey,
    connectionId: null,
  };

  ensureEventLoopDelayMonitorStarted();

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

  // Tracks the highest seq enqueued during the synchronous replay drain.
  // Live events that race in with seq <= this watermark are dropped to
  // avoid double-delivery -- broadcastMessage stamps and rings BEFORE
  // calling publish, so any in-flight event mid-replay is already in the
  // replay window we just drained.
  let highWaterReplaySeq = -1;

  const callback: AssistantEventCallback = (event) => {
    const controller = controllerRef;
    if (!controller) return;
    if (
      event.seq != null &&
      highWaterReplaySeq >= 0 &&
      event.seq <= highWaterReplaySeq
    ) {
      // Already delivered via replay; skip the duplicate.
      return;
    }
    try {
      if (controller.desiredSize != null && controller.desiredSize <= 0) {
        shedReporter("callback_backpressure", instrumentation);
        sub.dispose();
        cleanup();
        return;
      }
      controller.enqueue(encoder.encode(formatSseFrame(event)));
      instrumentation.eventsDelivered += 1;
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
            actorPrincipalId,
          })
        : hub.subscribe({
            ...subscriberBase,
            type: "process" as const,
          });
    // Stamp the hub-assigned connection id so a later backpressure shed can be
    // tied back to this specific connection in logs.
    instrumentation.connectionId = sub.connectionId;
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

        // Reconnect replay: when the caller passed lastSeenSeq, deliver
        // any buffered events the client missed before the first
        // heartbeat. `seq` is a single global per-assistant counter, so
        // one cursor resumes the stream regardless of how many
        // conversations are multiplexed on an unfiltered connection.
        // Replay re-applies the subscriber's targeting filter; a
        // conversation-scoped subscription additionally scopes replay to
        // its own conversation (other conversations are never delivered
        // live on that connection, so replaying them would be wrong).
        //
        // If the cursor is older than the ring's oldest entry,
        // `getReplayWindow` returns `null`. We do not surface that to
        // the client over the wire -- the connection just goes live.
        // The client detects the gap from the seq jump on its first
        // live event and refetches via the existing messages API.
        if (lastSeenSeq != null) {
          const replaySubscriber: ReplaySubscriber =
            clientId && interfaceId
              ? {
                  type: "client",
                  clientId,
                  interfaceId,
                  capabilities: ALL_CAPABILITIES.filter((cap) =>
                    supportsHostProxy(interfaceId, cap),
                  ),
                }
              : { type: "process" };
          const window = getReplayWindow(
            lastSeenSeq,
            replaySubscriber,
            filter.conversationId,
          );
          if (window !== null) {
            for (const replayed of window) {
              controller.enqueue(encoder.encode(formatSseFrame(replayed)));
              instrumentation.eventsDelivered += 1;
              if (replayed.seq != null && replayed.seq > highWaterReplaySeq) {
                highWaterReplaySeq = replayed.seq;
              }
            }
          }
        }

        controller.enqueue(encoder.encode(formatSseHeartbeat()));
        instrumentation.heartbeatsSent += 1;

        heartbeatTimer = setInterval(() => {
          try {
            if (controller.desiredSize != null && controller.desiredSize <= 0) {
              shedReporter("heartbeat_backpressure", instrumentation);
              sub.dispose();
              cleanup();
              return;
            }
            if (clientId) {
              hub.touchClient(clientId);
            }
            controller.enqueue(encoder.encode(formatSseHeartbeat()));
            instrumentation.heartbeatsSent += 1;
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

/**
 * Replay-by-request companion to the SSE `lastSeenSeq` resume: return the
 * ring-buffered event tail for one conversation with `seq > fromSeq`.
 *
 * A client recovering from a delivery gap fetches the `/messages` snapshot
 * (anchored at the seq of the last durably persisted event) and then this
 * tail from that anchor, folding the returned envelopes through the same
 * apply path as live SSE events. Snapshot-at-anchor plus tail-from-anchor
 * is deterministically complete, without bouncing the live connection —
 * the request/response twin of reconnecting with `lastSeenSeq`.
 *
 * `complete: false` means the ring no longer reaches back to `fromSeq`
 * (eviction) and no contiguous tail can be served — the caller must treat
 * the snapshot alone as the recovery, exactly as an out-of-ring reconnect
 * does. Targeting filters are re-applied from the caller's client identity
 * headers, mirroring the SSE replay path, so targeted events do not leak
 * outside their delivery set.
 */
function handleEventsTail({
  queryParams,
  headers,
}: RouteHandlerArgs): Record<string, unknown> {
  const conversationId = queryParams?.conversationId?.trim();
  if (!conversationId) {
    throw new BadRequestError("conversationId query parameter is required");
  }
  const rawFromSeq = queryParams?.fromSeq;
  if (rawFromSeq == null || rawFromSeq.trim() === "") {
    throw new BadRequestError("fromSeq query parameter is required");
  }
  const fromSeq = Number(rawFromSeq);
  if (!Number.isInteger(fromSeq) || fromSeq < 0) {
    throw new BadRequestError("fromSeq must be a non-negative integer");
  }
  // Optional upper bound: a caller that already knows where its live
  // delivery resumed (e.g. the seq-gap heal's first live event) can trim
  // the response to exactly the hole. Purely a bandwidth trim — the
  // client fold is seq-idempotent, so an unbounded overlap with live
  // delivery is harmless.
  const rawToSeq = queryParams?.toSeq;
  let toSeq: number | null = null;
  if (rawToSeq != null && rawToSeq.trim() !== "") {
    const parsed = Number(rawToSeq);
    if (!Number.isInteger(parsed) || parsed < fromSeq) {
      throw new BadRequestError(
        "toSeq must be an integer greater than or equal to fromSeq",
      );
    }
    toSeq = parsed;
  }

  // Same client-identity resolution as the SSE subscribe handler, so the
  // replay filter matches what a live subscription would have delivered.
  const rawClientId = headers?.["x-vellum-client-id"];
  const clientId = rawClientId?.trim() || null;
  const interfaceId = clientId
    ? parseInterfaceId(headers?.["x-vellum-interface-id"]?.trim())
    : null;
  const subscriber: ReplaySubscriber | undefined =
    clientId && interfaceId
      ? {
          type: "client",
          clientId,
          interfaceId,
          capabilities: ALL_CAPABILITIES.filter((cap) =>
            supportsHostProxy(interfaceId, cap),
          ),
        }
      : undefined;

  const window = getReplayWindow(fromSeq, subscriber, conversationId);
  if (window === null) {
    return { events: [], complete: false, frontier: null };
  }
  const bounded =
    toSeq === null
      ? window
      : window.filter((e) => typeof e.seq === "number" && e.seq <= toSeq);
  const lastSeq =
    bounded.length > 0 ? bounded[bounded.length - 1]?.seq : undefined;
  return {
    events: bounded,
    complete: true,
    frontier: typeof lastSeq === "number" ? lastSeq : fromSeq,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const EmitEventBodySchema = z.object({
  kind: z.enum(["contacts_changed"]),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "emit_event",
    endpoint: "events/emit",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Emit an assistant event",
    description:
      "Trigger an in-process assistant event by kind. Used by the gateway after owning a write that the assistant runtime would normally emit.",
    tags: ["events"],
    requestBody: EmitEventBodySchema,
    responseStatus: "204",
    handler: ({ body }) => {
      const { kind } = EmitEventBodySchema.parse(body);
      if (kind === "contacts_changed") {
        notifyContactsChanged();
      }
      return null;
    },
  },
  {
    operationId: "subscribe_assistant_events",
    endpoint: "events",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Subscribe to assistant events",
    description: "Stream assistant events as Server-Sent Events (SSE).",
    tags: ["events"],
    queryParams: [
      {
        name: "conversationId",
        description:
          "Scope to a single conversation by its assistant-minted internal id. 404s if no such conversation exists.",
      },
      {
        name: "conversationKey",
        description:
          "Scope to a single conversation by an external key (non-vellum channels) or the web idempotency key. Materializes a row on first use. Ignored when conversationId is also provided.",
      },
      {
        name: "lastSeenSeq",
        description:
          "Optional reconnect cursor: the highest global event seq the client has already applied. `seq` is a single per-assistant counter shared across all conversations, so one cursor resumes the stream regardless of how many conversations are multiplexed on the connection. When set, the daemon replays any buffered events with seq > lastSeenSeq (re-applying the subscriber's targeting/scope filter) before going live. If the cursor is older than the ring buffer's oldest entry the connection simply goes live; the client is expected to detect the gap from the next event's seq and refetch via the messages API. Must be a non-negative integer.",
      },
    ],
    responseHeaders: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    handler: (args) => handleSubscribeAssistantEvents(args),
  },
  {
    operationId: "events_tail_get",
    endpoint: "events/tail",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Fetch a conversation's buffered event tail",
    description:
      "Return the ring-buffered assistant events for one conversation with seq greater than fromSeq — the request/response twin of reconnecting the SSE stream with lastSeenSeq. A client recovering from a delivery gap fetches the /messages snapshot (anchored at its seq watermark) and then this tail from that anchor, folding the returned envelopes through the same apply path as live events; snapshot plus tail is deterministically complete. complete=false means the ring no longer reaches back to fromSeq and the snapshot alone must serve as the recovery.",
    tags: ["events"],
    queryParams: [
      {
        name: "conversationId",
        description:
          "Assistant-minted internal conversation id whose events to return. Required.",
      },
      {
        name: "fromSeq",
        description:
          "Return buffered events with seq strictly greater than this value — typically the seq watermark of a just-fetched /messages snapshot. Must be a non-negative integer.",
      },
      {
        name: "toSeq",
        description:
          "Optional inclusive upper bound on returned seqs. A caller that already knows where its live delivery resumed (e.g. the first live event after a gap) can trim the response to exactly the hole. Purely a bandwidth trim — client folds are seq-idempotent, so overlap with live delivery is harmless without it. Must be an integer >= fromSeq.",
      },
    ],
    responseBody: z.object({
      events: z
        .array(z.unknown())
        .describe(
          "Buffered assistant event envelopes ({id, conversationId, emittedAt, seq, message}) with seq > fromSeq, ascending, filtered to the conversation and to the caller's delivery set (client identity headers). Same wire shape as the /events SSE data frames.",
        ),
      complete: z
        .boolean()
        .describe(
          "True when the ring still covered fromSeq, so the returned events are the contiguous tail. False when eviction broke contiguity — events is empty and the caller must recover from the snapshot alone.",
        ),
      frontier: z
        .number()
        .nullable()
        .describe(
          "Seq of the last returned event (or fromSeq when the tail is empty but contiguous). Null when complete is false.",
        ),
    }),
    handler: (args) => handleEventsTail(args),
  },
];
