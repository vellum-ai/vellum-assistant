import { describe, expect, test } from "bun:test";

import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { ContextBuffer } from "./context-buffer.js";
import {
  type PerceptionEvent,
  perceptionEventType,
} from "./perception-event.js";

function makeEvent(
  overrides: Partial<
    Extract<PerceptionEvent["payload"], { kind: "app_focus_changed" }>
  > = {},
): PerceptionEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    source: { module: "test", version: "0" },
    payload: {
      kind: "app_focus_changed",
      appId: "com.apple.Safari",
      appName: "Safari",
      windowTitle: "Example",
      redacted: false,
      ...overrides,
    },
  };
}

function appNameOf(event: PerceptionEvent): string | null {
  return event.payload.kind === "app_focus_changed"
    ? event.payload.appName
    : null;
}

function envelope(event: PerceptionEvent): {
  id: string;
  emittedAt: string;
  message: { type: string; perception: PerceptionEvent };
} {
  return {
    id: event.eventId,
    emittedAt: event.ts,
    message: {
      type: perceptionEventType(event.payload.kind),
      perception: event,
    },
  };
}

describe("ContextBuffer.ingest", () => {
  test("stores valid perception events most-recent-first", () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const buf = new ContextBuffer({ now: () => new Date(now) });

    buf.ingest(envelope(makeEvent({ appName: "First" })));
    now += 1000;
    buf.ingest(envelope(makeEvent({ appName: "Second" })));

    const recent = buf.recent();
    expect(recent).toHaveLength(2);
    expect(appNameOf(recent[0]!.event)).toBe("Second");
    expect(appNameOf(recent[1]!.event)).toBe("First");
  });

  test("ignores non-perception events", () => {
    const buf = new ContextBuffer();
    buf.ingest({ id: "x", emittedAt: "now", message: { type: "pong" } });
    buf.ingest({});
    buf.ingest(null);
    expect(buf.size()).toBe(0);
  });

  test("rejects malformed perception payloads without throwing", () => {
    const buf = new ContextBuffer();
    buf.ingest({
      id: "x",
      emittedAt: "now",
      message: {
        type: "perception.app_focus_changed",
        perception: { junk: 1 },
      },
    });
    expect(buf.size()).toBe(0);
  });

  test("evicts oldest when over capacity", () => {
    const buf = new ContextBuffer({ maxEntries: 2 });
    buf.ingest(envelope(makeEvent({ appName: "A" })));
    buf.ingest(envelope(makeEvent({ appName: "B" })));
    buf.ingest(envelope(makeEvent({ appName: "C" })));
    expect(buf.size()).toBe(2);
    const recent = buf.recent();
    expect(recent.map((e) => appNameOf(e.event))).toEqual(["C", "B"]);
  });

  test("expires entries past TTL", () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const buf = new ContextBuffer({ ttlMs: 1000, now: () => new Date(now) });

    buf.ingest(envelope(makeEvent({ appName: "old" })));
    now += 5000;
    buf.ingest(envelope(makeEvent({ appName: "new" })));

    const recent = buf.recent();
    expect(recent).toHaveLength(1);
    expect(appNameOf(recent[0]!.event)).toBe("new");
  });
});

describe("ContextBuffer.recent filters", () => {
  test("windowMs limits to events received within window", () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const buf = new ContextBuffer({
      ttlMs: 60_000,
      now: () => new Date(now),
    });

    buf.ingest(envelope(makeEvent({ appName: "old" })));
    now += 30_000;
    buf.ingest(envelope(makeEvent({ appName: "fresh" })));

    const recent = buf.recent({ windowMs: 5_000 });
    expect(recent).toHaveLength(1);
    expect(appNameOf(recent[0]!.event)).toBe("fresh");
  });

  test("limit caps result size", () => {
    const buf = new ContextBuffer();
    for (let i = 0; i < 5; i += 1) {
      buf.ingest(envelope(makeEvent({ appName: `app-${i}` })));
    }
    expect(buf.recent({ limit: 2 })).toHaveLength(2);
  });

  test("kind filter narrows to one perception kind", () => {
    const buf = new ContextBuffer();
    buf.ingest(envelope(makeEvent()));
    expect(buf.recent({ kind: "app_focus_changed" })).toHaveLength(1);
  });
});

describe("ContextBuffer.attach", () => {
  test("subscribes to a hub and ingests published perception events", async () => {
    const hub = new AssistantEventHub();
    const buf = new ContextBuffer();
    buf.attach(hub);

    const event = makeEvent({ appName: "Safari" });
    await hub.publish(
      envelope(event) as unknown as Parameters<typeof hub.publish>[0],
    );

    const recent = buf.recent();
    expect(recent).toHaveLength(1);
    expect(appNameOf(recent[0]!.event)).toBe("Safari");
  });

  test("attach is idempotent", () => {
    const hub = new AssistantEventHub();
    const buf = new ContextBuffer();
    const first = buf.attach(hub);
    const second = buf.attach(hub);
    expect(first).toBe(second);
  });

  test("detach unsubscribes so later publishes are dropped", async () => {
    const hub = new AssistantEventHub();
    const buf = new ContextBuffer();
    buf.attach(hub);
    buf.detach();

    await hub.publish(
      envelope(makeEvent()) as unknown as Parameters<typeof hub.publish>[0],
    );

    expect(buf.size()).toBe(0);
  });
});
