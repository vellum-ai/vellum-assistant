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

import * as Sentry from "@sentry/node";
import { z } from "zod";

import type { HostProxyCapability } from "../../channels/types.js";
import { parseInterfaceId, supportsHostProxy } from "../../channels/types.js";
import { emitContactChange } from "../../contacts/contact-events.js";
import { getConversation } from "../../memory/conversation-crud.js";
import { getOrCreateConversation } from "../../memory/conversation-key-store.js";
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
import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import type { ReplaySubscriber } from "../conversation-stream-state.js";
import { getReplayWindow } from "../conversation-stream-state.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("events-routes");

/** Keep-alive comment sent to idle clients every 7 s by default. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000;

/**
 * Reconnect cursor map sent by resumable-stream clients: conversation id ->
 * highest event seq the client has already applied for that conversation.
 * Each conversation owns an independent per-conversation seq space, so a
 * single cursor cannot resume the unfiltered (assistant-wide) stream that
 * multiplexes many conversations -- the map carries one cursor per
 * conversation instead. Clients bound the map to their most-recently-active
 * conversations before sending.
 */
const ReconnectCursorsSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

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
 * we still emit the shed log + Sentry capture without lag stats rather
 * than crashing the SSE handler.
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
}

export type SseShedReason = "callback_backpressure" | "heartbeat_backpressure";

export type SseShedReporter = (
  reason: SseShedReason,
  inst: SseSubscriberInstrumentation,
) => void;

/**
 * Build the structured payload sent to Sentry when an SSE subscriber is
 * shed under backpressure.
 *
 * The conversation key is deliberately excluded: for channel-backed
 * conversations (WhatsApp, Telegram, etc.) the key embeds external
 * identifiers — phone numbers, chat IDs — and Sentry contexts are not
 * run through the PII redactor in `instrument.ts` (only
 * `exception.values`, `breadcrumbs`, and `extra` are). Correlation
 * with the client-side `sse_watchdog_fired` event is achieved via the
 * `client_id` tag + timestamp instead.
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
    event_loop_delay_mean_ms: elDelay.mean_ms,
    event_loop_delay_p99_ms: elDelay.p99_ms,
    event_loop_delay_max_ms: elDelay.max_ms,
  };
}

/**
 * Report a backpressure-shed event from an SSE subscriber to logs and Sentry.
 *
 * SSE subscribers are shed when `controller.desiredSize <= 0`: the consumer
 * has stopped reading and the stream's bounded queue is full. From the
 * daemon's side this looks identical to a hung client — and the visible
 * symptom on the client side is the 45 s idle-watchdog firing (Sentry
 * issue `sse_watchdog_fired`). Surfacing the shed lets us time-correlate
 * the two sides and attribute stalls to either backpressure or another
 * cause (network drop, event-loop starvation, etc.).
 *
 * The Sentry call uses level="warning" intentionally: a shed is a
 * saturation event, not an internal error.
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

  try {
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      scope.setTag("sse_shed_reason", reason);
      if (inst.clientId) scope.setTag("client_id", inst.clientId);
      if (inst.interfaceId) scope.setTag("interface_id", inst.interfaceId);
      scope.setContext("sse_shed", sentryContext);
      Sentry.captureMessage(`sse_subscriber_shed:${reason}`);
    });
  } catch {
    // Never let a telemetry failure break the SSE path.
  }
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
 *                        under backpressure (defaults to log + Sentry capture).
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
  const rawLastSeenSeqs = queryParams?.lastSeenSeqs;
  if ("conversationId" in (queryParams ?? {}) && !rawConversationId?.trim()) {
    throw new BadRequestError("conversationId must not be empty");
  }
  if ("conversationKey" in (queryParams ?? {}) && !rawConversationKey?.trim()) {
    throw new BadRequestError("conversationKey must not be empty");
  }

  // Parse the optional reconnect cursor map (resumable stream). Each entry
  // maps a conversation id to the highest event seq the client has already
  // applied for that conversation; on reconnect the daemon replays buffered
  // events with seq > cursor for each listed conversation. A seq of 0 is
  // valid -- it means "replay this conversation's full ring" (the client
  // has the conversation open but has not yet applied any event). Omitting
  // the param entirely means "no replay attempt, just connect live".
  let reconnectCursors: Map<string, number> | null = null;
  if (rawLastSeenSeqs != null) {
    const trimmed = rawLastSeenSeqs.trim();
    if (trimmed === "") {
      throw new BadRequestError("lastSeenSeqs must not be empty");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      throw new BadRequestError("lastSeenSeqs must be a valid JSON object");
    }
    const result = ReconnectCursorsSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new BadRequestError(
        "lastSeenSeqs must map conversation ids to non-negative integer seqs",
      );
    }
    reconnectCursors = new Map(Object.entries(result.data));
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
  const actorPrincipalId = resolveActorPrincipalIdForLocalGuardian(
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

  const ALL_CAPABILITIES: HostProxyCapability[] = [
    "host_bash",
    "host_file",
    "host_cu",
    "host_app_control",
    "host_browser",
  ];

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

  // Tracks, per conversation, the highest seq enqueued during the
  // synchronous replay drain. Live events that race in with seq <= a
  // conversation's watermark are dropped to avoid double-delivery --
  // broadcastMessage stamps and rings BEFORE calling publish, so any
  // in-flight event mid-replay is already in the replay window we just
  // drained. The watermark is per-conversation because the unfiltered
  // stream multiplexes independent per-conversation seq spaces.
  const highWaterReplaySeqByConversation = new Map<string, number>();

  // Per-conversation subscriber-filtered sequence counters. Incremented
  // for each conversation-scoped event this specific subscriber receives
  // (after capability/client/interface targeting), producing a gap-free
  // sequence from the subscriber's perspective. Clients use `clientSeq`
  // for gap detection instead of the global `seq` to avoid false
  // positives from targeted events they never receive.
  const clientSeqCounters = new Map<string, number>();
  function nextClientSeqFor(conversationId: string): number {
    const next = (clientSeqCounters.get(conversationId) ?? 0) + 1;
    clientSeqCounters.set(conversationId, next);
    return next;
  }

  const callback: AssistantEventCallback = (event) => {
    const controller = controllerRef;
    if (!controller) return;
    const eventConversationId = event.conversationId;
    if (event.seq != null && eventConversationId != null) {
      const watermark =
        highWaterReplaySeqByConversation.get(eventConversationId);
      if (watermark != null && event.seq <= watermark) {
        // Already delivered via replay; skip the duplicate.
        return;
      }
    }
    try {
      if (controller.desiredSize != null && controller.desiredSize <= 0) {
        shedReporter("callback_backpressure", instrumentation);
        sub.dispose();
        cleanup();
        return;
      }
      const frame =
        event.conversationId != null && event.seq != null
          ? { ...event, clientSeq: nextClientSeqFor(event.conversationId) }
          : event;
      controller.enqueue(encoder.encode(formatSseFrame(frame)));
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

        // Reconnect replay (resumable stream): when the caller passed a
        // per-conversation cursor map, deliver any buffered events the
        // client missed before the first heartbeat. Each conversation's
        // events are replayed in its own seq order.
        //
        // The web client opens a single unfiltered (assistant-wide) SSE
        // connection that multiplexes every conversation, and each
        // conversation owns an independent seq space -- so one cursor
        // cannot resume it. The cursor map lets every conversation replay
        // its own gap on that one connection. A scoped subscription only
        // delivers its own conversation live, so it replays just that
        // entry from the map.
        //
        // If a conversation's cursor is older than its ring's oldest
        // entry, `getReplayWindow` returns `null` and that conversation
        // is skipped (no wire signal); the client detects the gap from
        // the next live event's seq and refetches via the messages API.
        // Other conversations still replay.
        if (reconnectCursors && reconnectCursors.size > 0) {
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

          // A scoped subscription only delivers its own conversation
          // live, so replaying any other conversation's gap would push
          // events the client will never see again live. Restrict the
          // replay set accordingly.
          const cursorsToReplay: Array<[string, number]> = [];
          if (filter.conversationId) {
            const cursor = reconnectCursors.get(filter.conversationId);
            if (cursor != null) {
              cursorsToReplay.push([filter.conversationId, cursor]);
            }
          } else {
            for (const entry of reconnectCursors) {
              cursorsToReplay.push(entry);
            }
          }

          for (const [conversationId, cursor] of cursorsToReplay) {
            const window = getReplayWindow(
              conversationId,
              cursor,
              replaySubscriber,
            );
            if (window === null) {
              continue;
            }
            for (const replayed of window) {
              const frame =
                replayed.conversationId != null && replayed.seq != null
                  ? {
                      ...replayed,
                      clientSeq: nextClientSeqFor(replayed.conversationId),
                    }
                  : replayed;
              controller.enqueue(encoder.encode(formatSseFrame(frame)));
              instrumentation.eventsDelivered += 1;
              if (replayed.seq != null && replayed.conversationId != null) {
                const prev =
                  highWaterReplaySeqByConversation.get(
                    replayed.conversationId,
                  ) ?? -1;
                if (replayed.seq > prev) {
                  highWaterReplaySeqByConversation.set(
                    replayed.conversationId,
                    replayed.seq,
                  );
                }
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
        emitContactChange();
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
        name: "lastSeenSeqs",
        description:
          "Optional reconnect cursor map, JSON-encoded as an object of conversation id -> highest per-conversation event seq the client has already applied. On reconnect the daemon replays buffered events with seq greater than the cursor for each listed conversation before going live, each conversation in its own seq order. This resumes the single unfiltered (assistant-wide) stream, whose multiplexed conversations each own an independent seq space and so cannot be resumed by one cursor. A scoped subscription replays only its own conversation's entry. A conversation whose cursor predates its ring buffer is skipped (the client detects the gap from the next event's seq and refetches via the messages API); other conversations still replay. Seqs must be non-negative integers.",
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
