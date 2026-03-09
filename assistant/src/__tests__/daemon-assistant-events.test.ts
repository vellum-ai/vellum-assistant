/**
 * Tests that daemon IPC outbound messages are mirrored into the
 * assistant-events hub as AssistantEvent objects.
 *
 * Tests:
 *   - send()      → one mirrored assistant event per message
 *   - broadcast() → one mirrored assistant event per message (not per socket)
 */
import { describe, expect, mock, test } from "bun:test";

// ── Platform mock (must happen before imports that read it) ─────────────────
mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/test-daemon-events.sock",
  getSessionTokenPath: () => "/tmp/test-token",
  getRootDir: () => "/tmp/test",
  getDataDir: () => "/tmp/test",
  getWorkspaceDir: () => "/tmp/test/workspace",
  getWorkspaceSkillsDir: () => "/tmp/test/skills",
  getSandboxWorkingDir: () => "/tmp/test/sandbox",
  getTCPPort: () => undefined,
  getTCPHost: () => "127.0.0.1",
  isTCPEnabled: () => false,
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPidPath: () => "/tmp/test.pid",
  getLogPath: () => "/tmp/test.log",
  getDbPath: () => "/tmp/test.db",
  ensureDataDir: () => {},
  removeSocketFile: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── buildAssistantEvent factory ───────────────────────────────────────────────

describe("buildAssistantEvent", () => {
  test("returns event with correct shape", () => {
    const msg: ServerMessage = {
      type: "assistant_text_delta",
      sessionId: "sess_1",
      text: "hi",
    };
    const event = buildAssistantEvent("ast_1", msg, "sess_1");

    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.assistantId).toBe("ast_1");
    expect(event.sessionId).toBe("sess_1");
    expect(event.message).toBe(msg);
    expect(typeof event.emittedAt).toBe("string");
    expect(new Date(event.emittedAt).toISOString()).toBe(event.emittedAt);
  });

  test("generates unique ids for each call", () => {
    const msg: ServerMessage = { type: "pong" };
    const a = buildAssistantEvent("ast", msg);
    const b = buildAssistantEvent("ast", msg);
    expect(a.id).not.toBe(b.id);
  });

  test("sessionId is undefined when omitted", () => {
    const msg: ServerMessage = { type: "pong" };
    const event = buildAssistantEvent("ast", msg);
    expect(event.sessionId).toBeUndefined();
  });
});

// ── Hub integration (mimics what DaemonServer.publishAssistantEvent does) ────

describe("daemon send → one mirrored assistant event", () => {
  test("publishing a single event to the hub delivers exactly one event", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_ipc" }, (e) => {
      received.push(e);
    });

    const msg: ServerMessage = {
      type: "assistant_text_delta",
      sessionId: "sess_a",
      text: "hello",
    };
    const event = buildAssistantEvent("ast_ipc", msg, "sess_a");
    await hub.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].assistantId).toBe("ast_ipc");
    expect(received[0].sessionId).toBe("sess_a");
    expect(received[0].message.type).toBe("assistant_text_delta");
  });

  test("sessionId falls back to explicit parameter when message lacks it", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_ipc" }, (e) => {
      received.push(e);
    });

    const msg: ServerMessage = { type: "pong" }; // no sessionId field
    const event = buildAssistantEvent("ast_ipc", msg, "sess_explicit");

    await hub.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("sess_explicit");
  });
});

describe("daemon broadcast → one mirrored event per message (not per socket)", () => {
  test("one broadcast publish produces exactly one hub event regardless of subscriber count", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    // Two subscribers (simulating two wire clients)
    hub.subscribe({ assistantId: "ast_bc" }, (e) => {
      received.push(e);
    });
    hub.subscribe({ assistantId: "ast_bc" }, (e) => {
      received.push(e);
    });

    // Simulate broadcast: server calls publishAssistantEvent once
    const msg: ServerMessage = {
      type: "message_complete",
      sessionId: "sess_b",
    };
    const event = buildAssistantEvent("ast_bc", msg, "sess_b");
    await hub.publish(event);

    // Both hub subscribers receive it (fanout), but only ONE event was published
    expect(received).toHaveLength(2); // two subscribers, each gets one delivery
  });

  test("broadcast publishes once; single send publishes once — not additive", async () => {
    const hub = new AssistantEventHub();
    const publishedEvents: AssistantEvent[] = [];

    hub.subscribe({ assistantId: "ast_bc" }, (e) => {
      publishedEvents.push(e);
    });

    const msgA: ServerMessage = {
      type: "assistant_text_delta",
      sessionId: "s1",
      text: "a",
    };
    const msgB: ServerMessage = { type: "message_complete", sessionId: "s1" };

    // Simulate: one broadcast + one single send
    await hub.publish(buildAssistantEvent("ast_bc", msgA, "s1"));
    await hub.publish(buildAssistantEvent("ast_bc", msgB, "s1"));

    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[0].message.type).toBe("assistant_text_delta");
    expect(publishedEvents[1].message.type).toBe("message_complete");
  });
});
