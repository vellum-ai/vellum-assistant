/**
 * Behavioral test for the open_conversation server message type wired
 * through the generic emit-event signal.
 *
 * The CLI (or any in-process daemon caller) writes a JSON-encoded
 * ServerMessage to `<signalsDir>/emit-event` and the daemon's signal
 * handler reads it and republishes it through the assistantEventHub so
 * SSE subscribers receive it.
 *
 * This test verifies that the OpenConversation envelope round-trips
 * through that bridge unchanged.
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { handleEmitEventSignal } from "../signals/emit-event.js";
import { getSignalsDir } from "../util/platform.js";

function signalPath(): string {
  return join(getSignalsDir(), "emit-event");
}

const subscriptions: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const sub of subscriptions.splice(0)) {
    sub.dispose();
  }
  const path = signalPath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
});

describe("handleEmitEventSignal — open_conversation", () => {
  test("publishes an open_conversation envelope to subscribed listeners", async () => {
    mkdirSync(getSignalsDir(), { recursive: true });

    const payload = {
      type: "open_conversation" as const,
      conversationId: "conv-test-1",
      title: "Seeded thread",
      anchorMessageId: "msg-1",
    };

    writeFileSync(signalPath(), JSON.stringify(payload), "utf-8");

    const received: AssistantEvent[] = [];
    let resolveDelivered: (() => void) | null = null;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });

    subscriptions.push(
      assistantEventHub.subscribe(
        { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
        (event) => {
          received.push(event);
          resolveDelivered?.();
        },
      ),
    );

    handleEmitEventSignal();

    await delivered;

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
    expect(event.message).toEqual(payload);
    // Spot-check the envelope fields the SSE route relies on.
    expect(typeof event.id).toBe("string");
    expect(typeof event.emittedAt).toBe("string");
  });
});
