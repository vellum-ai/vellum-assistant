/**
 * Behavioral test for the generic CLI→daemon event bridge.
 *
 * Callers write a JSON-encoded {@link ServerMessage} to
 * `<signalsDir>/emit-event`. {@link handleEmitEventSignal} reads that
 * payload and republishes it through the {@link assistantEventHub} so
 * SSE subscribers receive it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
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

describe("handleEmitEventSignal", () => {
  test("reads a ServerMessage from the signal file and publishes it to the event hub", async () => {
    mkdirSync(getSignalsDir(), { recursive: true });

    const payload: ServerMessage = { type: "tasks_changed" };

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
    expect(typeof event.id).toBe("string");
    expect(typeof event.emittedAt).toBe("string");
  });
});
