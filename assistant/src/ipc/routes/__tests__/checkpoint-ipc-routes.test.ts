import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import {
  CHECKPOINT_PREPARE_IPC_METHOD,
  handleCheckpointPrepare,
} from "../checkpoint-ipc-routes.js";

describe(`${CHECKPOINT_PREPARE_IPC_METHOD} IPC route`, () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  });

  function subscribeClient(clientId: string, onEvict: () => void) {
    const sub = assistantEventHub.subscribe({
      type: "client",
      clientId,
      interfaceId: "web",
      capabilities: [],
      callback: () => {},
      onEvict,
    });
    disposers.push(() => sub.dispose());
    return sub;
  }

  test("disposes every client subscriber and closes its stream via onEvict", async () => {
    const evicted: string[] = [];
    const clientA = subscribeClient("checkpoint-client-a", () =>
      evicted.push("a"),
    );
    const clientB = subscribeClient("checkpoint-client-b", () =>
      evicted.push("b"),
    );

    const result = await handleCheckpointPrepare({});

    expect(result).toEqual({ ok: true, disposedSseClients: 2 });
    expect(evicted.sort()).toEqual(["a", "b"]);
    expect(clientA.active).toBe(false);
    expect(clientB.active).toBe(false);
    expect(assistantEventHub.listClients()).toHaveLength(0);
  });

  test("leaves in-process subscribers untouched", async () => {
    const processSub = assistantEventHub.subscribe({
      type: "process",
      callback: () => {},
    });
    disposers.push(() => processSub.dispose());
    subscribeClient("checkpoint-client-c", () => {});

    const result = await handleCheckpointPrepare({});

    expect(result).toEqual({ ok: true, disposedSseClients: 1 });
    expect(processSub.active).toBe(true);
  });

  test("is a no-op with no connected clients", async () => {
    const result = await handleCheckpointPrepare({});
    expect(result).toEqual({ ok: true, disposedSseClients: 0 });
  });
});
