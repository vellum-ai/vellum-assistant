/**
 * Tests for SSE subscriber shed-on-backpressure observability.
 *
 * Verifies that when `controller.desiredSize <= 0`, the SSE route invokes
 * the injected shed reporter with the correct reason and per-subscriber
 * context. Both shed sites are covered: the event-callback path (slow
 * subscriber + publishes filling the queue) and the heartbeat-timer path
 * (slow subscriber with no published events). The healthy path asserts
 * no shed report fires.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  buildSseShedSentryContext,
  handleSubscribeAssistantEvents,
  type SseShedReason,
  type SseSubscriberInstrumentation,
} from "../runtime/routes/events-routes.js";

initializeDb();

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

interface ShedReport {
  reason: SseShedReason;
  events_delivered: number;
  heartbeats_sent: number;
  client_id: string | null;
  interface_id: string | null;
  conversation_key: string | null;
  connection_id: string | null;
  subscription_age_ms: number;
}

function makeReporterCaptor(): {
  reports: ShedReport[];
  reporter: (reason: SseShedReason, inst: SseSubscriberInstrumentation) => void;
} {
  const reports: ShedReport[] = [];
  return {
    reports,
    reporter: (reason, inst) => {
      reports.push({
        reason,
        events_delivered: inst.eventsDelivered,
        heartbeats_sent: inst.heartbeatsSent,
        client_id: inst.clientId,
        interface_id: inst.interfaceId,
        conversation_key: inst.conversationKey,
        connection_id: inst.connectionId,
        subscription_age_ms: Date.now() - inst.subscribedAtMs,
      });
    },
  };
}

const SSE_HIGH_WATER_MARK = 16;

describe("SSE route — backpressure shed observability", () => {
  beforeEach(clearTables);

  test("invokes shedReporter with reason=callback_backpressure when publishes saturate the queue", async () => {
    const hub = new AssistantEventHub();
    const { reports, reporter } = makeReporterCaptor();
    const ac = new AbortController();

    handleSubscribeAssistantEvents(
      {
        queryParams: { conversationKey: "shed-cb-test" },
        abortSignal: ac.signal,
      },
      { hub, shedReporter: reporter },
    );
    expect(hub.subscriberCount()).toBe(1);

    // Saturate the stream's bounded queue without reading from it.
    // start() already enqueued the immediate heartbeat (queue=1), so
    // publishing `SSE_HIGH_WATER_MARK` events triggers the shed on the
    // final publish when desiredSize hits 0.
    for (let i = 0; i < SSE_HIGH_WATER_MARK; i += 1) {
      await hub.publish(buildAssistantEvent({ type: "pong" }));
    }

    expect(hub.subscriberCount()).toBe(0);
    expect(reports.length).toBe(1);
    expect(reports[0]?.reason).toBe("callback_backpressure");
    expect(reports[0]?.events_delivered).toBe(SSE_HIGH_WATER_MARK - 1);
    // The initial heartbeat enqueued by start() must be counted so the
    // reported queue depth matches what was actually pushed.
    expect(reports[0]?.heartbeats_sent).toBe(1);
    expect(reports[0]?.conversation_key).toBe("shed-cb-test");
    expect(typeof reports[0]?.subscription_age_ms).toBe("number");

    ac.abort();
  });

  test("invokes shedReporter with reason=heartbeat_backpressure when the heartbeat tick finds desiredSize<=0", async () => {
    const hub = new AssistantEventHub();
    const { reports, reporter } = makeReporterCaptor();
    const ac = new AbortController();

    handleSubscribeAssistantEvents(
      {
        queryParams: { conversationKey: "shed-hb-test" },
        abortSignal: ac.signal,
      },
      { hub, heartbeatIntervalMs: 20, shedReporter: reporter },
    );
    expect(hub.subscriberCount()).toBe(1);

    // Fill the queue up to its limit without sending the publish that
    // would shed via the callback path.
    for (let i = 0; i < SSE_HIGH_WATER_MARK - 1; i += 1) {
      await hub.publish(buildAssistantEvent({ type: "pong" }));
    }
    expect(reports.length).toBe(0);

    await new Promise((r) => setTimeout(r, 60));

    expect(reports.length).toBe(1);
    expect(reports[0]?.reason).toBe("heartbeat_backpressure");
    expect(reports[0]?.conversation_key).toBe("shed-hb-test");

    ac.abort();
  });

  test("does not invoke shedReporter when a reader drains the stream", async () => {
    const hub = new AssistantEventHub();
    const { reports, reporter } = makeReporterCaptor();
    const ac = new AbortController();

    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: { conversationKey: "shed-healthy-test" },
        abortSignal: ac.signal,
      },
      { hub, heartbeatIntervalMs: 1_000, shedReporter: reporter },
    );

    const reader = stream.getReader();
    void reader.read();

    for (let i = 0; i < 32; i += 1) {
      await hub.publish(buildAssistantEvent({ type: "pong" }));
      void reader.read();
    }

    expect(reports.length).toBe(0);

    ac.abort();
    void reader.cancel();
  });

  test("captures client identity in the shed instrumentation context", async () => {
    const hub = new AssistantEventHub();
    const { reports, reporter } = makeReporterCaptor();
    const ac = new AbortController();

    handleSubscribeAssistantEvents(
      {
        queryParams: { conversationKey: "shed-client-test" },
        headers: {
          "x-vellum-client-id": "client-abc",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub, shedReporter: reporter },
    );

    for (let i = 0; i < SSE_HIGH_WATER_MARK; i += 1) {
      await hub.publish(buildAssistantEvent({ type: "pong" }));
    }

    expect(reports.length).toBe(1);
    expect(reports[0]?.client_id).toBe("client-abc");
    expect(reports[0]?.interface_id).toBe("macos");
    // The hub-assigned per-connection id is threaded into the shed
    // report so a shed can be attributed to a specific connection even
    // when several share a clientId across reconnects.
    expect(reports[0]?.connection_id).toMatch(/^conn-/);

    ac.abort();
  });
});

describe("buildSseShedSentryContext", () => {
  const inst: SseSubscriberInstrumentation = {
    subscribedAtMs: 1_000,
    eventsDelivered: 7,
    heartbeatsSent: 3,
    clientId: "client-xyz",
    interfaceId: "macos",
    // Channel-backed conversation key embedding a phone number.
    conversationKey: "asst:self:whatsapp:447123456789",
    connectionId: "conn-1",
  };
  const elDelay = { mean_ms: 1.2, p99_ms: 3.4, max_ms: 5.6 };

  test("omits conversation_key so Sentry contexts do not leak PII", () => {
    const ctx = buildSseShedSentryContext(
      "callback_backpressure",
      inst,
      elDelay,
      2_500,
    );
    expect(ctx).not.toHaveProperty("conversation_key");
    expect(ctx).not.toHaveProperty("conversationKey");
    expect(JSON.stringify(ctx)).not.toContain("447123456789");
  });

  test("preserves non-PII per-subscriber and runtime fields", () => {
    const ctx = buildSseShedSentryContext(
      "heartbeat_backpressure",
      inst,
      elDelay,
      2_500,
    );
    expect(ctx).toMatchObject({
      reason: "heartbeat_backpressure",
      subscription_age_ms: 1_500,
      events_delivered: 7,
      heartbeats_sent: 3,
      client_id: "client-xyz",
      interface_id: "macos",
      connection_id: "conn-1",
      event_loop_delay_mean_ms: 1.2,
      event_loop_delay_p99_ms: 3.4,
      event_loop_delay_max_ms: 5.6,
    });
  });
});
