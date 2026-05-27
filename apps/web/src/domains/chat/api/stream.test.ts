import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject module is imported so the
// happy-path (mocked Sentry) is exercised.
// ---------------------------------------------------------------------------

interface SentryBreadcrumbCall {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}
interface SentryCaptureMessageCall {
  message: string;
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

const sentryBreadcrumbs: SentryBreadcrumbCall[] = [];
const sentryCaptureMessages: SentryCaptureMessageCall[] = [];

mock.module("@sentry/browser", () => ({
  addBreadcrumb: (crumb: SentryBreadcrumbCall) => {
    sentryBreadcrumbs.push(crumb);
  },
  captureMessage: (
    message: string,
    options?: {
      level?: string;
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    },
  ) => {
    sentryCaptureMessages.push({
      message,
      level: options?.level,
      tags: options?.tags,
      extra: options?.extra,
    });
  },
  captureException: () => {},
}));

import {
  getChatDiagnosticsEvents,
} from "@/domains/chat/utils/diagnostics";
import {
  type TurnState,
  INITIAL_TURN_STATE,
  turnReducer,
  isSending,
} from "@/domains/messaging/turn-store";
import { parseAssistantEvent } from "@/domains/chat/api/event-parser";
import { subscribeChatEvents, type ChatStreamReconnectCause } from "@/domains/chat/api/stream";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

describe("polling reconciliation with state machine", () => {
  /**
   * Simulates the page-level flow where polling completion dispatches a
   * POLL_RECONCILED event through the turn reducer.  These tests verify
   * the contract between the polling path and the state machine.
   */

  test("poll completion transitions active turn to idle", () => {
    // Simulate: user sends (thinking) -> poll finds reply -> dispatch POLL_RECONCILED
    const afterSend = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-poll-1",
    });
    expect(isSending(afterSend)).toBe(true);

    const afterPoll = turnReducer(afterSend, {
      type: "POLL_RECONCILED",
      turnId: "t-poll-1",
    });
    expect(afterPoll.phase).toBe("idle");
    expect(isSending(afterPoll)).toBe(false);
    expect(afterPoll.lastTerminalReason).toBe("complete");
  });

  test("SSE completes before poll — poll for same turnId is no-op", () => {
    // SSE path: send -> delta -> message_complete
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-1",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    // Poll arrives late for the same turn — should be a no-op
    const afterPoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-1",
    });
    expect(afterPoll).toEqual(state);
  });

  test("poll completes before SSE — SSE message_complete is idempotent", () => {
    // Poll path completes first
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-2",
    });
    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-2",
    });
    expect(state.phase).toBe("idle");

    // SSE message_complete arrives late — already idle, idempotent
    const afterSSE = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(afterSSE.phase).toBe("idle");
    expect(afterSSE.lastTerminalReason).toBe("complete");
  });

  test("stale poll does not interfere with new turn", () => {
    // Turn 1: send -> complete
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-old",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });

    // Turn 2: send (now active)
    state = turnReducer(state, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-new",
    });
    expect(state.activeTurnId).toBe("t-new");
    expect(state.phase).toBe("thinking");

    // Stale poll from turn 1 arrives — should NOT affect turn 2
    const afterStalePoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-old",
    });
    expect(afterStalePoll.phase).toBe("thinking");
    expect(afterStalePoll.activeTurnId).toBe("t-new");
  });

  test("poll without turnId still works for backward compatibility", () => {
    const afterSend = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-compat",
    });
    // Legacy-style poll without turnId
    const afterPoll = turnReducer(afterSend, {
      type: "POLL_RECONCILED",
    });
    expect(afterPoll.phase).toBe("idle");
    expect(afterPoll.lastTerminalReason).toBe("complete");
  });

  test("SSE events mapped from wire format produce correct domain events", () => {
    // Verify that parseAssistantEvent produces events that map correctly
    // to domain events consumed by the reducer
    const delta = parseAssistantEvent({
      type: "assistant_text_delta",
      text: "hello",
    });
    expect(delta.type).toBe("assistant_text_delta");

    const complete = parseAssistantEvent({
      type: "message_complete",
      content: "done",
    });
    expect(complete.type).toBe("message_complete");

    const handoff = parseAssistantEvent({ type: "generation_handoff" });
    expect(handoff.type).toBe("generation_handoff");

    const error = parseAssistantEvent({ type: "error", message: "fail" });
    expect(error.type).toBe("error");

    // The page maps these wire types to domain event types:
    // assistant_text_delta -> ASSISTANT_TEXT_DELTA
    // message_complete     -> MESSAGE_COMPLETE
    // generation_handoff   -> GENERATION_HANDOFF
    // error                -> STREAM_ERROR

    // Verify domain events flow correctly through reducer
    let state: TurnState = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-wire",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
  });

  // ---- activeTurnId guard on idle re-activation ----

  test("ASSISTANT_TEXT_DELTA does NOT re-activate idle when activeTurnId is null", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-guard-1",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    const afterDelta = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(afterDelta.phase).toBe("idle");
  });

  test("ASSISTANT_TEXT_DELTA re-activates idle when activeTurnId is set", () => {
    const forcedIdle: TurnState = {
      phase: "idle",
      activeTurnId: "t-guard-2",
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const afterDelta = turnReducer(forcedIdle, { type: "ASSISTANT_TEXT_DELTA" });
    expect(afterDelta.phase).toBe("streaming");
    expect(afterDelta.activeTurnId).toBe("t-guard-2");
  });

  test("TOOL_USE_START does NOT re-activate idle when activeTurnId is null", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-guard-3",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    const afterTool = turnReducer(state, { type: "TOOL_USE_START" });
    expect(afterTool.phase).toBe("idle");
    expect(afterTool.activeToolCallCount).toBe(0);
  });

  test("TOOL_USE_START re-activates idle when activeTurnId is set", () => {
    const forcedIdle: TurnState = {
      phase: "idle",
      activeTurnId: "t-guard-4",
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: null,
      statusText: null,
      liveWebActivity: {},
      autoRoutedProfileLabel: null,
    };
    const afterTool = turnReducer(forcedIdle, { type: "TOOL_USE_START" });
    expect(afterTool.phase).toBe("thinking");
    expect(afterTool.activeToolCallCount).toBe(1);
  });

  test("POLL_RECONCILED → stale delta → new send works end-to-end", () => {
    // Simulates the full background/foreground race:
    // 1. Turn starts → streaming
    // 2. POLL_RECONCILED idles the turn (activeTurnId → null)
    // 3. Stale ASSISTANT_TEXT_DELTA arrives → should be ignored
    // 4. User sends new message → new turn starts cleanly
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-bg",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");

    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-bg",
    });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("idle");

    state = turnReducer(state, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-new",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("t-race-new");
  });

  test("ASSISTANT_TEXT_DELTA still transitions thinking → streaming (no guard)", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-thinking",
    });
    expect(state.phase).toBe("thinking");

    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
  });
});

describe("subscribeChatEvents idle watchdog", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // The vellum-api request interceptor reads document.cookie via
    // ensureCsrfCookie() on mutating requests; harmless for this GET
    // path but keeps the bun (Node) test env consistent.
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    // Reset the version-gating store so subscribeChatEvents defaults to
    // the legacy `conversationKey` wire field. Tests that exercise the
    // newer `conversationId` path opt in explicitly via setIdentity().
    useAssistantIdentityStore.getState().clearIdentity();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
    useAssistantIdentityStore.getState().clearIdentity();
  });

  test("omits any conversation query param when subscribing to all assistant events", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      null,
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain("/v1/assistants/asst-1/events/");
      // Neither the legacy nor the canonical wire field should appear when
      // subscribing to all assistant events (no conversation filter).
      expect(requestedUrls[0]).not.toContain("conversationKey");
      expect(requestedUrls[0]).not.toContain("conversationId");
    } finally {
      stream.cancel();
    }
  });

  test("uses conversationId query when daemon version >= 0.8.6", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");

    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-internal-1",
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      const url = new URL(requestedUrls[0]!);
      expect(url.searchParams.get("conversationId")).toBe("conv-internal-1");
      expect(url.searchParams.get("conversationKey")).toBeNull();
    } finally {
      stream.cancel();
    }
  });

  test("uses conversationKey query when daemon version is older than 0.8.6", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.5");

    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-key-legacy",
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      const url = new URL(requestedUrls[0]!);
      expect(url.searchParams.get("conversationKey")).toBe("conv-key-legacy");
      expect(url.searchParams.get("conversationId")).toBeNull();
    } finally {
      stream.cancel();
    }
  });

  test("falls back to conversationKey when daemon version is unknown", async () => {
    // Default store state: identity not yet hydrated. Conservative
    // fallback to the legacy field is the only safe choice — older
    // daemons silently ignore `conversationId`.
    expect(useAssistantIdentityStore.getState().version).toBeNull();

    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-unknown-version",
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      const url = new URL(requestedUrls[0]!);
      expect(url.searchParams.get("conversationKey")).toBe("conv-unknown-version");
      expect(url.searchParams.get("conversationId")).toBeNull();
    } finally {
      stream.cancel();
    }
  });

  test("force-reconnects when the SSE stream stalls past the idle timeout", async () => {
    // When the SSE transport silently stalls (no bytes flowing) but
    // never raises an error, the for-await-of loop in
    // subscribeChatEvents blocks forever and any messages emitted
    // server-side never reach the UI. The watchdog must abort the
    // active fetch after idleTimeoutMs and let the existing reconnect
    // path open a fresh connection.
    let fetchCallCount = 0;
    const capturedSignals: AbortSignal[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        if (signal) capturedSignals.push(signal);

        // A body that never produces any bytes — the watchdog is the
        // only thing that can break this stream out of its read.
        const body = new ReadableStream({
          start() {
            // Intentionally empty: never enqueue, never close.
          },
        });

        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    ) as unknown as typeof fetch;

    const onEvent = mock(() => {});
    const onError = mock(() => {});
    let reconnectCallbacks = 0;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-key",
      onEvent,
      onError,
      {
        // Short timings so the test runs in well under a second.
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: () => {
          reconnectCallbacks++;
        },
      },
    );

    try {
      // Allow: connect → stall → watchdog (~50ms) → reconnect delay
      // (~10ms) → second connect, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      // The watchdog must have aborted at least the first attempt and
      // forced the SDK to open a fresh fetch.
      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      expect(capturedSignals[0]?.aborted).toBe(true);

      // Reconnect path was actually exercised, so reconcileActive-
      // Conversation() (wired by callers as onReconnect) would fire.
      expect(reconnectCallbacks).toBeGreaterThanOrEqual(1);
    } finally {
      stream.cancel();
    }
  });

  test("does not arm the watchdog while a slow onReconnect callback is in flight", async () => {
    // client.sse.get returns a lazy async generator: the underlying
    // fetch only kicks off on the first iterator pull, and the
    // onReconnect callback (which performs an HTTP reconcile
    // roundtrip and can take longer than idleTimeoutMs in practice)
    // sits between the two. Arming the watchdog before onReconnect
    // resolves would charge that reconcile time against the timeout
    // and could abort the new attempt before any SSE traffic ever
    // started — burning the reconnect budget on a recoverable
    // connection.
    let fetchCallCount = 0;
    const signalAbortedAtFetchStart: boolean[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        signalAbortedAtFetchStart.push(signal?.aborted ?? false);

        return new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire and trigger reconnect.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Comfortably longer than idleTimeoutMs: simulates a slow
        // reconcileActiveConversation() round-trip.
        onReconnect: async () => {
          await new Promise((r) => setTimeout(r, 150));
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // slow onReconnect (~150ms) → second fetch starts.
      await new Promise((r) => setTimeout(r, 400));

      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      // The signal each attempt receives must not already be aborted
      // at the moment the SDK initiates its fetch — if it were, the
      // watchdog would have charged the onReconnect window against
      // its budget and aborted the attempt before the stream could
      // produce any traffic.
      expect(signalAbortedAtFetchStart[0]).toBe(false);
      expect(signalAbortedAtFetchStart[1]).toBe(false);
    } finally {
      stream.cancel();
    }
  });

  test("records sse_watchdog_fired with attempt + idleTimeoutMs when the stream stalls", async () => {
    // The deferred Layer 2/3 watchdog work hinges on field data
    // showing how often the watchdog actually fires in production.
    // The diagnostic must (a) be recorded before the abort cascade
    // tears down per-attempt state, and (b) carry enough context
    // (attempt counter + idleTimeoutMs) for downstream analysis to
    // distinguish first-attempt fires from reconnect-attempt fires.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;
    const breadcrumbsBefore = sentryBreadcrumbs.length;
    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-watchdog",
      "conv-watchdog",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      // Comfortably past the first watchdog fire (~50ms).
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(fires.length).toBeGreaterThanOrEqual(1);
      const first = fires[0]!;
      expect(first.details).toMatchObject({
        assistantId: "asst-watchdog",
        conversationId: "conv-watchdog",
        idleTimeoutMs: 50,
      });
      // The first watchdog fire happens on the very first connect
      // attempt, before any reconnect has incremented the counter.
      expect(first.details.attempt).toBe(0);
      // Centralized platform tag is injected by recordChatDiagnostic.
      expect(first.details.platform).toBe("web");

      // Sentry mirrors are how fleet data answers the L2/L3 question.
      // Without these, telemetry is gated on user-submitted support
      // bundles, which biases the sample toward broken-and-noisy.
      const newBreadcrumbs = sentryBreadcrumbs.slice(breadcrumbsBefore);
      const watchdogBreadcrumb = newBreadcrumbs.find(
        (crumb) =>
          crumb.category === "sse.watchdog" &&
          crumb.message === "watchdog_fired",
      );
      expect(watchdogBreadcrumb).toBeDefined();
      expect(watchdogBreadcrumb!.data).toMatchObject({
        assistantId: "asst-watchdog",
        idleTimeoutMs: 50,
      });
      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      // platform must be a tag (not just an extra) so the L2/L3
      // breakdown — Capacitor iOS vs web — is one Discover query
      // away. Sentry's auto-detected os.name does not distinguish
      // Capacitor iOS from Safari iOS.
      expect(watchdogCapture!.tags).toMatchObject({
        context: "sse_watchdog",
        platform: "web",
      });
      expect(watchdogCapture!.extra).toMatchObject({
        assistantId: "asst-watchdog",
        conversationId: "conv-watchdog",
        idleTimeoutMs: 50,
      });
    } finally {
      sub.cancel();
    }
  });

  test("tags watchdog fires with wasTurnSending + liveness counters so user-harming vs benign stalls are aggregable", async () => {
    // The 100% bucket=0 reading on `sse_post_watchdog_reconcile_result`
    // collapses two populations into one: stalls during an in-flight
    // turn (user-harming — visible blank screen) and stalls on an
    // idle stream after a turn completed (benign — user is not
    // waiting on anything). Without splitting these, the Layer 2/3
    // decision is uninterpretable, because the L2/L3 work only
    // helps the first population.
    //
    // wasTurnSending is the dimension that splits them: promoted to a
    // tag so a single Discover groupBy answers "what fraction of
    // watchdog fires happen while the user is waiting?" The liveness
    // counters (keepalivesReceivedSinceConnect, dataFramesReceivedSinceConnect,
    // lastByteAgeMs) further split each population by whether vembda
    // was alive at the time of the stall, distinguishing
    // "vembda alive, daemon silent" from "server never responded"
    // from "stream died mid-turn".
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;
    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-aggregation",
      "conv-aggregation",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Caller supplies a synchronous snapshot of turn state at
        // watchdog-fire time. Returning true here models a stall
        // during an in-flight turn — the user-harming case.
        getActiveTurnSending: () => true,
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // The diagnostic carries the same fields as the Sentry extras
      // so support snapshots (which only ship the diagnostics
      // buffer, not Sentry events) can answer the same questions.
      expect(firstFire!.details).toMatchObject({
        wasTurnSending: true,
        // No SSE traffic arrived because the stream stalled on
        // first byte, so the counters stay at zero and
        // lastByteAgeMs stays null (distinguishes
        // "server never responded" from "stream stalled after
        // some traffic").
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });

      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      // wasTurnSending is promoted to a TAG (not just extra) so
      // Discover can groupBy it. String-encoded because Sentry
      // tag values must be strings.
      expect(watchdogCapture!.tags).toMatchObject({
        context: "sse_watchdog",
        wasTurnSending: "true",
      });
      // And mirrored as an extra so per-event drill-in shows the
      // raw boolean alongside the counters.
      expect(watchdogCapture!.extra).toMatchObject({
        wasTurnSending: true,
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("tags wasTurnSending: 'unknown' when no getActiveTurnSending snapshot is supplied", async () => {
    // Backwards compatibility: callers that have not yet wired the
    // turn-sending snapshot (e.g. unit tests of subscribeChatEvents
    // in isolation, or any caller pre-LUM-1538) must still produce
    // a tag value, not omit the field. Sentry groups absent tags as
    // `"<no-tag>"` in Discover, which collides with healthy events
    // that legitimately have no value. Sending `"unknown"` makes
    // the missing-instrumentation population explicit.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-no-snapshot",
      "conv-no-snapshot",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      expect(watchdogCapture!.tags).toMatchObject({
        wasTurnSending: "unknown",
      });
      // Extra remains the raw `null` so per-event drill-in
      // distinguishes "caller didn't provide" from "caller
      // provided false".
      expect(watchdogCapture!.extra).toMatchObject({
        wasTurnSending: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("counts heartbeat comment frames and data frames separately so vembda-alive vs server-silent stalls are distinguishable", async () => {
    // Comment frames (vembda's `: keepalive\n\n` heartbeats and the
    // daemon's own heartbeats) reset the watchdog but never yield
    // through the for-await iterator. Counting them separately
    // from data frames lets the diagnostic distinguish three
    // failure modes at the moment of a stall:
    //
    //   - keepalives > 0, dataFrames = 0 → vembda alive, daemon silent
    //     (the daemon stopped emitting tokens but the vembda
    //     keepalive injector is still running)
    //   - keepalives = 0, dataFrames > 0 → stream died mid-turn
    //     (data was flowing but suddenly stopped with no keepalive
    //     before the timeout)
    //   - keepalives = 0, dataFrames = 0 → server never responded
    //     (no traffic at all on this attempt)
    //
    // Each of these maps to a different fix. Without splitting the
    // counters, the watchdog fire is uninterpretable.
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              // Two heartbeat comment frames (no data:line) and one
              // data frame, then stall.
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(
                encoder.encode('event: token\ndata: "hello"\n\n'),
              );
              // Now stall — let the watchdog fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;

    const sub = subscribeChatEvents(
      "asst-heartbeat",
      "conv-heartbeat",
      () => {},
      () => {},
      { idleTimeoutMs: 100, reconnectBaseDelayMs: 10 },
    );

    try {
      // First fire happens after the data frame at ~20ms +
      // idleTimeoutMs = ~120ms. 250ms gives comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // Two heartbeat comment frames and one data frame arrived
      // before the stall.
      expect(firstFire!.details.keepalivesReceivedSinceConnect).toBe(2);
      expect(firstFire!.details.dataFramesReceivedSinceConnect).toBe(1);
      // lastByteAgeMs is the time since the last SSE chunk; with
      // idleTimeoutMs=100 the watchdog fires ~100ms after the
      // last chunk, so the age should be in the 100-200ms range.
      // Don't pin a tight bound (the test runner's clock has
      // resolution >1ms); just assert it is a positive number,
      // not null (which would mean "no traffic at all").
      expect(typeof firstFire!.details.lastByteAgeMs).toBe("number");
      expect(firstFire!.details.lastByteAgeMs as number).toBeGreaterThanOrEqual(
        90,
      );
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'watchdog' to onReconnect after the watchdog aborts a stall", async () => {
    // Distinguishing watchdog-driven reconnects from ordinary
    // transport-error reconnects is what makes the post-reconnect
    // reconcile_result diagnostic interpretable: a "messages
    // recovered" signal is only meaningful when scoped to the
    // silent-stall recovery path.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // onReconnect invoked, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      // Every reconnect in this scenario is watchdog-driven because
      // the stalling fetch never produces an SDK-surfaced error.
      for (const cause of causes) {
        expect(cause).toBe("watchdog");
      }
    } finally {
      sub.cancel();
    }
  });

  test("does not falsely tag a transport error as watchdog-driven when the timer would fire mid-backoff", async () => {
    // Regression for the stale-timer hazard: armWatchdog runs a
    // setTimeout that survives the for-await loop's exit, so a
    // transport error close to the idle deadline can leave the
    // timer armed during the reconnect backoff. If the timer then
    // fires before the next connect attempt, the new diagnostic
    // path would set lastAbortCause = "watchdog" and tag a
    // recoverable error path as a watchdog stall in telemetry.
    // Verifies that clearing the watchdog when the for-await loop
    // exits prevents that false attribution.
    // Every attempt errors after ~50ms — earlier than the 100ms
    // idle deadline — so the watchdog should never legitimately
    // fire under test. With the fix in place, the timer is cleared
    // when the for-await loop exits, before the reconnect backoff
    // window opens; without it, the timer would fire mid-backoff
    // and false-tag the next reconnect as watchdog-driven.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      const localCount = fetchCallCount;
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.error(
                new Error(`transport failure ${localCount}`),
              );
            }, 50);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];
    const eventCountBefore = getChatDiagnosticsEvents().length;

    const sub = subscribeChatEvents(
      "asst-stale",
      "conv-stale",
      () => {},
      () => {},
      {
        // Tight idle window + longer backoff: the original idle
        // timer's deadline (100ms) lands inside the reconnect
        // backoff window (200ms), so a stale fire would be
        // observable as a "watchdog" cause on the next attempt.
        idleTimeoutMs: 100,
        reconnectBaseDelayMs: 200,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // First fetch errors (~50ms) → reconnect awaits 200ms →
      // second connect runs at ~250ms (also errors at ~50ms in).
      // 400ms gives a clean window with exactly one onReconnect
      // call observable and no watchdog opportunity on attempt 2.
      await new Promise((r) => setTimeout(r, 400));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");

      // No sse_watchdog_fired diagnostic should have been recorded
      // for this subscription — every fetch errored before its
      // watchdog deadline, so any fire is from a stale timer.
      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) =>
          event.kind === "sse_watchdog_fired" &&
          (event.details as { assistantId?: unknown }).assistantId ===
            "asst-stale",
      );
      expect(fires.length).toBe(0);
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'error' to onReconnect when the stream surfaces a transport error", async () => {
    // Symmetric counterpart to the watchdog-cause test: when the SDK
    // raises an error on the iterator (a real transport failure, not
    // a silent stall), the reconnect path must report `cause:
    // "error"` so callers don't tag the post-reconnect reconcile as
    // a watchdog-recovery in their telemetry.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First attempt: body errors out shortly after open. The SDK
        // surfaces this via onSseError, which ends the iterator and
        // sends connect() down its reconnect branch with no watchdog
        // involvement.
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.error(new Error("transport failure"));
              }, 10);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      // Subsequent attempts stall so we can cancel cleanly without
      // the test cascading through more reconnect rounds.
      return new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        // Generous idle timeout: must comfortably exceed the
        // ~10ms transport error + ~10ms reconnect delay + the
        // measurement window below, so the watchdog cannot race
        // the error path and contaminate the recorded cause.
        idleTimeoutMs: 5000,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");
    } finally {
      sub.cancel();
    }
  });

  test("cancel() halts further reconnects after the watchdog fires", async () => {
    // The watchdog must not survive cancel(): otherwise a stalled
    // stream that the caller has already torn down would keep
    // hammering the daemon with reconnect attempts.
    let fetchCallCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(
        new ReadableStream({
          start() {
            // Never produce bytes — force the watchdog to fire.
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    // Wait long enough for at least one watchdog fire + reconnect.
    await new Promise((r) => setTimeout(r, 200));
    sub.cancel();
    const countAtCancel = fetchCallCount;

    // After cancel, no further attempts should be scheduled.
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchCallCount).toBe(countAtCancel);
  });
});
