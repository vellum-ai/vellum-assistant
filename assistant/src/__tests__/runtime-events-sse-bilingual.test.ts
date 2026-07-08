/**
 * `GET /v1/events` (`handleSubscribeAssistantEvents`) — bilingual scope
 * resolution. Two query params are accepted, with distinct semantics:
 *
 *   - `?conversationId=<internal-id>` — looks up the conversation row
 *     directly by its assistant-minted id. 404 if not found. Does NOT
 *     materialise a new row.
 *   - `?conversationKey=<external-key>` — resolves via the
 *     `conversation_keys` table; materialises on first use. Ignored when
 *     `conversationId` is also supplied.
 *
 * Companion to `runtime-events-sse.test.ts`, which exercises the broader
 * `?conversationKey=` happy/error path.
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

import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

await initializeDb();

describe("GET /v1/events — bilingual scope query params", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
  });

  test("?conversationId=<existing-id> scopes the stream to that conversation", async () => {
    // Materialise a conversation via the key path, then subscribe to it
    // directly by its internal id.
    const { conversationId } = getOrCreateConversation("sse-id-scope-source");

    const ac = new AbortController();
    const testHub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: { conversationId },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );

    const reader = stream.getReader();
    // Consume the initial heartbeat.
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");

    // Publish an event scoped to that conversation — should be delivered.
    await testHub.publish(
      buildAssistantEvent({ type: "pong" }, conversationId),
    );

    const { value, done } = await reader.read();
    ac.abort();

    expect(done).toBe(false);
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain("event: assistant_event");
    expect(frame).toContain(`"conversationId":"${conversationId}"`);
  });

  test("?conversationId=<non-existent-id> throws NotFoundError", () => {
    expect(() =>
      handleSubscribeAssistantEvents({
        queryParams: { conversationId: "does-not-exist" },
        abortSignal: new AbortController().signal,
      }),
    ).toThrow(NotFoundError);
  });

  test("?conversationId is honored and ?conversationKey is ignored when both are present", async () => {
    // Materialise two distinct conversations: one we'll subscribe to by id,
    // one we'll publish to via the ignored key.
    const { conversationId: idConv } = getOrCreateConversation("sse-id-wins");
    const { conversationId: keyConv } =
      getOrCreateConversation("sse-key-ignored");
    expect(idConv).not.toBe(keyConv);

    const ac = new AbortController();
    const testHub = new AssistantEventHub();

    const stream = handleSubscribeAssistantEvents(
      {
        queryParams: {
          conversationId: idConv,
          conversationKey: "sse-key-ignored",
        },
        abortSignal: ac.signal,
      },
      { hub: testHub },
    );
    const reader = stream.getReader();
    await reader.read(); // heartbeat

    // Publish on the "key" conversation — should NOT be delivered (filter
    // is locked to idConv because conversationId wins).
    await testHub.publish(buildAssistantEvent({ type: "pong" }, keyConv));
    // Publish on the "id" conversation — should be delivered.
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
