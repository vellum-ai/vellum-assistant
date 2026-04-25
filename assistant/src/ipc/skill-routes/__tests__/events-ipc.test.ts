/**
 * Integration tests for the `host.events.*` skill IPC routes.
 *
 * Exercises the three routes registered in `skill-routes/events.ts`
 * against a live `SkillIpcServer` on a temporary socket path:
 *
 * - `host.events.publish` — publishes an event and verifies it reaches the
 *   daemon's `assistantEventHub` exactly as an in-process publish would.
 * - `host.events.buildEvent` — verifies deterministic envelope construction
 *   under `DAEMON_INTERNAL_ASSISTANT_ID`.
 * - `host.events.subscribe` — long-lived stream: confirms open ack, filtered
 *   delivery (match vs. mismatch), explicit close, and cleanup on client
 *   disconnect (including that the hub releases its subscription slot).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../../../runtime/assistant-event.js";
import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../runtime/assistant-scope.js";
import { SkillIpcServer } from "../../skill-server.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
let server: SkillIpcServer | null = null;
let socketPath = "";

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "events-ipc-test-"));
  socketPath = join(tempDir, "assistant-skill.sock");
  server = new SkillIpcServer({ socketPath });
  await server.start();
});

afterEach(async () => {
  server?.stop();
  server = null;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  // Give the event loop a tick to fully release resources.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

type Frame =
  | { id: string; result?: unknown; error?: string }
  | { id: string; event: "delivery"; payload: unknown };

interface TestClient {
  socket: Socket;
  nextFrame(): Promise<Frame>;
  send(payload: Record<string, unknown>): void;
  close(): void;
}

async function openClient(): Promise<TestClient> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", (err) => reject(err));
  });

  let buffer = "";
  const pending: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        pending.push(frame);
      }
    }
  });

  return {
    socket,
    nextFrame: () =>
      new Promise<Frame>((resolve, reject) => {
        const buffered = pending.shift();
        if (buffered) {
          resolve(buffered);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(settle);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("Timed out waiting for frame"));
        }, 1000);
        const settle = (frame: Frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
        waiters.push(settle);
      }),
    send: (payload) => {
      socket.write(JSON.stringify(payload) + "\n");
    },
    close: () => {
      socket.destroy();
    },
  };
}

async function waitForSubscriberCount(
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (assistantEventHub.subscriberCount() !== expected) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host.events.publish", () => {
  test("publish round-trip reaches assistantEventHub subscribers", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe(
      { assistantId: "test-asst" },
      (evt) => {
        received.push(evt);
      },
    );

    try {
      const client = await openClient();
      const event = {
        id: "evt-1",
        assistantId: "test-asst",
        conversationId: "conv-1",
        emittedAt: new Date().toISOString(),
        message: { type: "test_message", foo: "bar" },
      };
      client.send({
        id: "req-1",
        method: "host.events.publish",
        params: { event },
      });

      const frame = await client.nextFrame();
      expect("result" in frame && frame.result).toEqual({ published: true });

      expect(received).toHaveLength(1);
      expect(received[0]?.id).toBe("evt-1");
      expect(received[0]?.assistantId).toBe("test-asst");
      expect((received[0]?.message as unknown as { foo: string }).foo).toBe(
        "bar",
      );

      client.close();
    } finally {
      subscription.dispose();
    }
  });

  test("publish rejects malformed events", async () => {
    const client = await openClient();
    client.send({
      id: "req-bad",
      method: "host.events.publish",
      params: { event: { id: "x" } },
    });

    const frame = await client.nextFrame();
    expect("error" in frame && frame.error).toBeTruthy();

    client.close();
  });
});

describe("host.events.buildEvent", () => {
  test("returns an envelope attributed to DAEMON_INTERNAL_ASSISTANT_ID", async () => {
    const client = await openClient();
    const conversationId = "conv-xyz";
    const message = { type: "assistant_text_delta", text: "hi" };
    client.send({
      id: "req-1",
      method: "host.events.buildEvent",
      params: { message, conversationId },
    });

    const frame = await client.nextFrame();
    expect("result" in frame).toBe(true);
    const built = (frame as { result: AssistantEvent }).result;
    expect(built.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
    expect(built.conversationId).toBe(conversationId);
    expect(typeof built.id).toBe("string");
    expect(typeof built.emittedAt).toBe("string");
    expect(built.message).toEqual(message as typeof built.message);

    client.close();
  });
});

describe("host.events.subscribe", () => {
  test("opens ack, delivers matching events, filters non-matching", async () => {
    const baseSubscribers = assistantEventHub.subscriberCount();
    const client = await openClient();
    client.send({
      id: "sub-1",
      method: "host.events.subscribe",
      params: {
        filter: {
          assistantId: "asst-a",
          conversationId: "conv-a",
        },
      },
    });

    // Open acknowledgement.
    const ack = await client.nextFrame();
    expect("result" in ack && ack.result).toEqual({ subscribed: true });
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers + 1);

    // Matching event.
    await assistantEventHub.publish({
      id: "e1",
      assistantId: "asst-a",
      conversationId: "conv-a",
      emittedAt: new Date().toISOString(),
      message: { type: "t1" },
    } as never);

    const delivery = await client.nextFrame();
    expect("event" in delivery && delivery.event).toBe("delivery");
    expect(
      "payload" in delivery && (delivery.payload as AssistantEvent).id,
    ).toBe("e1");

    // Non-matching event on a different conversation.
    await assistantEventHub.publish({
      id: "e2",
      assistantId: "asst-a",
      conversationId: "conv-b",
      emittedAt: new Date().toISOString(),
      message: { type: "t2" },
    } as never);

    // Non-matching event on a different assistant.
    await assistantEventHub.publish({
      id: "e3",
      assistantId: "asst-b",
      conversationId: "conv-a",
      emittedAt: new Date().toISOString(),
      message: { type: "t3" },
    } as never);

    // Confirm no delivery frame arrives for the non-matching events by
    // publishing another matching event and asserting ordering.
    await assistantEventHub.publish({
      id: "e4",
      assistantId: "asst-a",
      conversationId: "conv-a",
      emittedAt: new Date().toISOString(),
      message: { type: "t4" },
    } as never);

    const nextDelivery = await client.nextFrame();
    expect(
      "payload" in nextDelivery && (nextDelivery.payload as AssistantEvent).id,
    ).toBe("e4");

    client.close();
    await waitForSubscriberCount(baseSubscribers);
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers);
  });

  test("explicit subscribe-close releases the hub subscription", async () => {
    const baseSubscribers = assistantEventHub.subscriberCount();
    const client = await openClient();
    client.send({
      id: "sub-2",
      method: "host.events.subscribe",
      params: { filter: { assistantId: "asst-close" } },
    });
    await client.nextFrame(); // ack
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers + 1);

    client.send({
      id: "ctrl-1",
      method: "host.events.subscribe.close",
      params: { subscribeId: "sub-2" },
    });

    const closeAck = await client.nextFrame();
    expect("result" in closeAck && closeAck.result).toEqual({ closed: true });
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers);

    client.close();
  });

  test("client disconnect releases the hub subscription", async () => {
    const baseSubscribers = assistantEventHub.subscriberCount();
    const client = await openClient();
    client.send({
      id: "sub-3",
      method: "host.events.subscribe",
      params: { filter: { assistantId: "asst-leak" } },
    });
    await client.nextFrame(); // ack
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers + 1);

    client.close();
    await waitForSubscriberCount(baseSubscribers);
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers);

    // Further publishes do not reach the disposed subscription. If the
    // subscription had leaked, the hub would invoke a callback whose
    // stream reference is destroyed — and we would see either an error
    // log or a thrown aggregate from `publish`. Both would surface here
    // because `publish` re-throws subscriber errors.
    await assistantEventHub.publish({
      id: "post",
      assistantId: "asst-leak",
      emittedAt: new Date().toISOString(),
      message: { type: "post" },
    } as never);
  });

  test("server shutdown tears down streams", async () => {
    const baseSubscribers = assistantEventHub.subscriberCount();
    const client = await openClient();
    client.send({
      id: "sub-4",
      method: "host.events.subscribe",
      params: { filter: { assistantId: "asst-stop" } },
    });
    await client.nextFrame(); // ack
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers + 1);

    server?.stop();
    server = null;
    await waitForSubscriberCount(baseSubscribers);
    expect(assistantEventHub.subscriberCount()).toBe(baseSubscribers);

    // Clean up the client socket; the server already destroyed it.
    client.close();
  });

  test("rejects duplicate subscribe id on the same socket", async () => {
    const client = await openClient();
    client.send({
      id: "sub-dup",
      method: "host.events.subscribe",
      params: { filter: { assistantId: "asst-dup" } },
    });
    const ack = await client.nextFrame();
    expect("result" in ack && ack.result).toEqual({ subscribed: true });

    client.send({
      id: "sub-dup",
      method: "host.events.subscribe",
      params: { filter: { assistantId: "asst-dup" } },
    });
    const err = await client.nextFrame();
    expect("error" in err && err.error).toContain("sub-dup");

    client.close();
  });

  test("subscribe-close on unknown id still acks", async () => {
    const client = await openClient();
    client.send({
      id: "ctrl-nop",
      method: "host.events.subscribe.close",
      params: { subscribeId: "does-not-exist" },
    });
    const frame = await client.nextFrame();
    expect("result" in frame && frame.result).toEqual({ closed: true });

    client.close();
  });
});
