/**
 * HTTP-layer integration tests for GET /v1/events (SSE assistant-events endpoint).
 *
 * Tests:
 *   - 401 unauthorized (missing bearer token)
 *   - 200 when conversationKey is omitted (unfiltered subscription)
 *   - Happy path: stream receives a published AssistantEvent
 *   - Unfiltered: streams events from multiple conversations
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { mintToken } from "../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

const TEST_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:test",
  scope_profile: "actor_client_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_JWT}` };

describe("SSE assistant-events endpoint", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
  });

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({ port: 0 });
    await server.start();
    port = server.actualPort;
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function eventsUrl(params = ""): string {
    return `http://127.0.0.1:${port}/v1/events${params ? `?${params}` : ""}`;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  test("401 when bearer token is missing", async () => {
    await startServer();

    const res = await fetch(eventsUrl("conversationKey=test-noauth"));
    expect(res.status).toBe(401);
    // Consume body to prevent resource leak
    await res.body?.cancel();

    await stopServer();
  });

  test("401 when bearer token is wrong", async () => {
    await startServer();

    const res = await fetch(eventsUrl("conversationKey=test-badauth"), {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();

    await stopServer();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  test("200 when conversationKey is omitted (unfiltered subscription)", async () => {
    await startServer();

    const res = await fetch(eventsUrl(), { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();

    await stopServer();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test("stream receives a published assistant event", async () => {
    // Test the handler directly (bypassing HTTP) to avoid chunked-transfer
    // buffering in Bun's loopback SSE implementation. The HTTP auth and
    // routing are already covered by other test files; here we focus on the
    // SSE subscription logic and frame delivery.
    const { conversationId } = getOrCreateConversation("sse-happy-path");

    const ac = new AbortController();

    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: { conversationKey: "sse-happy-path" },
      abortSignal: ac.signal,
    });

    // start() is called synchronously during ReadableStream construction, so the
    // hub subscription is already registered before we publish.
    const event = buildAssistantEvent({ type: "pong" }, conversationId);
    await assistantEventHub.publish(event);

    // Read the first frame directly from the stream.
    const reader = stream.getReader();

    // The first chunk is the immediate heartbeat comment enqueued in start().
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    expect(new TextDecoder().decode(initial.value)).toBe(": heartbeat\n\n");

    // The second chunk is the actual assistant event.
    const { value, done } = await reader.read();
    ac.abort();

    expect(done).toBe(false);
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain("event: assistant_event");
    expect(frame).toContain(`"conversationId":"${conversationId}"`);
    expect(frame).toContain('"type":"pong"');
  });

  // ── Unfiltered subscription ──────────────────────────────────────────────

  test("streams all events when conversationKey is omitted", async () => {
    // Subscribe without a conversationKey — should receive events from any conversation.
    const ac = new AbortController();

    const { AssistantEventHub } =
      await import("../runtime/assistant-event-hub.js");
    const testHub = new AssistantEventHub();

    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents(
      { abortSignal: ac.signal },
      { hub: testHub },
    );

    const reader = stream.getReader();

    // Consume the initial heartbeat.
    const heartbeat = await reader.read();
    expect(heartbeat.done).toBe(false);
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");

    // Publish events with two different conversationIds.
    const eventA = buildAssistantEvent({ type: "pong" }, "conversation-aaa");
    const eventB = buildAssistantEvent({ type: "pong" }, "conversation-bbb");
    await testHub.publish(eventA);
    await testHub.publish(eventB);

    // Read both frames from the stream.
    const frameA = await reader.read();
    expect(frameA.done).toBe(false);
    const textA = new TextDecoder().decode(frameA.value);
    expect(textA).toContain("conversation-aaa");

    const frameB = await reader.read();
    expect(frameB.done).toBe(false);
    const textB = new TextDecoder().decode(frameB.value);
    expect(textB).toContain("conversation-bbb");

    ac.abort();
  });
});
