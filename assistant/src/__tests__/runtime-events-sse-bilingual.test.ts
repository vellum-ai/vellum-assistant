/**
 * LUM-1890 Phase 1 — `GET /v1/events` (`handleSubscribeAssistantEvents`)
 * accepts the canonical `?conversationId=` query parameter as a synonym
 * for the legacy `?conversationKey=`. Both resolve to the same downstream
 * conversation-scoped subscription filter.
 *
 * Companion to `runtime-events-sse.test.ts` which exercises the existing
 * `?conversationKey=` path. This file is removable after Phase 4
 * deprecates `conversationKey` on the wire.
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
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

describe("GET /v1/events — Phase 1 bilingual query params", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
  });

  test("?conversationId= scopes the stream identically to ?conversationKey=", async () => {
    // Materialise the conversation under the same key so both parameter
    // names resolve to the same internal id.
    const sharedKey = "sse-bilingual-shared";
    const { conversationId } = getOrCreateConversation(sharedKey);

    const ac = new AbortController();
    const testHub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: { conversationId: sharedKey },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );

    const reader = stream.getReader();

    // Consume the initial heartbeat.
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");

    // Publish an event scoped to the resolved conversation id — the
    // bilingual filter should let it through.
    const event = buildAssistantEvent({ type: "pong" }, conversationId);
    await testHub.publish(event);

    const { value, done } = await reader.read();
    ac.abort();

    expect(done).toBe(false);
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain("event: assistant_event");
    expect(frame).toContain(`"conversationId":"${conversationId}"`);
  });

  test("conversationId wins over conversationKey when both are present", async () => {
    // The canonical param should be the one we resolve. We assert this by
    // materialising two distinct conversations and checking which one the
    // filter scopes to.
    const idKey = "sse-bilingual-id-wins";
    const keyKey = "sse-bilingual-key-loses";
    const { conversationId: idConv } = getOrCreateConversation(idKey);
    const { conversationId: keyConv } = getOrCreateConversation(keyKey);
    expect(idConv).not.toBe(keyConv);

    const ac = new AbortController();
    const testHub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: { conversationId: idKey, conversationKey: keyKey },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );
    const reader = stream.getReader();
    await reader.read(); // heartbeat

    // Publish on the "loser" first — should NOT be delivered.
    await testHub.publish(buildAssistantEvent({ type: "pong" }, keyConv));
    // Publish on the "winner" — should be delivered.
    await testHub.publish(buildAssistantEvent({ type: "pong" }, idConv));

    const { value } = await reader.read();
    ac.abort();
    const frame = new TextDecoder().decode(value);

    expect(frame).toContain(`"conversationId":"${idConv}"`);
    expect(frame).not.toContain(`"conversationId":"${keyConv}"`);
  });

  test("empty conversationId is rejected with BadRequestError", () => {
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: { conversationId: "" },
        abortSignal: new AbortController().signal,
      }),
    ).toThrow(BadRequestError);
  });

  test("empty conversationKey is still rejected (legacy parity)", () => {
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: { conversationKey: "" },
        abortSignal: new AbortController().signal,
      }),
    ).toThrow(BadRequestError);
  });
});
