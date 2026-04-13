import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../../assistant-event.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import { handleSubscribeAssistantEvents } from "../events-routes.js";

function makeEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    assistantId: "ast_1",
    conversationId: "conv_1",
    emittedAt: new Date().toISOString(),
    message: {
      type: "assistant_text_delta",
      conversationId: "conv_1",
      text: "hi",
    },
    ...overrides,
  };
}

/** Read all SSE frames from a Response stream until it's closed or we have enough. */
async function drainSseFrames(
  response: Response,
  maxFrames: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];

  const deadline = Date.now() + timeoutMs;
  while (frames.length < maxFrames && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    // Split on double newlines (SSE frame delimiter).
    const parts = chunk.split("\n\n").filter((p) => p.trim().length > 0);
    frames.push(...parts);
  }

  reader.releaseLock();
  return frames;
}

describe("events-routes — Last-Event-ID replay", () => {
  test("replays buffered events after Last-Event-ID on reconnect", async () => {
    const hub = new AssistantEventHub();

    // Publish 3 events to build up the buffer.
    const evt1 = makeEvent({ id: "evt_1", conversationId: "conv_replay" });
    const evt2 = makeEvent({ id: "evt_2", conversationId: "conv_replay" });
    const evt3 = makeEvent({ id: "evt_3", conversationId: "conv_replay" });
    await hub.publish(evt1);
    await hub.publish(evt2);
    await hub.publish(evt3);

    // Simulate a reconnect with Last-Event-ID: evt_1 — should replay evt_2 and evt_3.
    const req = new Request(
      "http://localhost/v1/events?conversationKey=conv_replay",
      { headers: { "Last-Event-ID": "evt_1" } },
    );
    const url = new URL(req.url);
    const response = handleSubscribeAssistantEvents(req, url, {
      hub,
      heartbeatIntervalMs: 60_000,
      skipActorVerification: true,
    });

    expect(response.status).toBe(200);

    // Read frames: first is heartbeat, then replay frames.
    const frames = await drainSseFrames(response, 5, 1000);
    const dataFrames = frames.filter((f) => f.startsWith("event:"));

    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
    expect(dataFrames[0]).toContain('"id":"evt_2"');
    expect(dataFrames[1]).toContain('"id":"evt_3"');
  });

  test("without Last-Event-ID the stream has no replay frames", async () => {
    const hub = new AssistantEventHub();

    const evt = makeEvent({ id: "evt_no_replay", conversationId: "conv_x" });
    await hub.publish(evt);

    const req = new Request(
      "http://localhost/v1/events?conversationKey=conv_x",
    );
    const url = new URL(req.url);
    const response = handleSubscribeAssistantEvents(req, url, {
      hub,
      heartbeatIntervalMs: 60_000,
      skipActorVerification: true,
    });

    expect(response.status).toBe(200);

    // Only a heartbeat comment should be present initially.
    const frames = await drainSseFrames(response, 3, 500);
    const dataFrames = frames.filter((f) => f.startsWith("event:"));
    expect(dataFrames).toHaveLength(0);
  });

  test("replay followed by a live event preserves ordering", async () => {
    const hub = new AssistantEventHub();
    const convId = "conv_order";

    const evt1 = makeEvent({ id: "evt_o1", conversationId: convId });
    const evt2 = makeEvent({ id: "evt_o2", conversationId: convId });
    await hub.publish(evt1);
    await hub.publish(evt2);

    // Subscribe with Last-Event-ID: evt_o1 → should replay evt_o2.
    const req = new Request(
      `http://localhost/v1/events?conversationKey=${convId}`,
      { headers: { "Last-Event-ID": "evt_o1" } },
    );
    const url = new URL(req.url);
    const response = handleSubscribeAssistantEvents(req, url, {
      hub,
      heartbeatIntervalMs: 60_000,
      skipActorVerification: true,
    });

    // Now publish a live event after subscribe.
    const evt3 = makeEvent({ id: "evt_o3", conversationId: convId });
    await hub.publish(evt3);

    const frames = await drainSseFrames(response, 5, 1000);
    const dataFrames = frames.filter((f) => f.startsWith("event:"));

    // Replay (evt_o2) should come before live (evt_o3).
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
    expect(dataFrames[0]).toContain('"id":"evt_o2"');
    expect(dataFrames[1]).toContain('"id":"evt_o3"');
  });
});
