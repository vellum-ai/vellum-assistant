import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../../../runtime/assistant-event-hub.js";
import {
  clearCheckpointQuiesce,
  closeAllSseSubscriptions,
  isCheckpointQuiesceActive,
  registerSseSubscription,
} from "../../../runtime/checkpoint-quiesce.js";
import { ServiceUnavailableError } from "../../../runtime/routes/errors.js";
import { handleSubscribeAssistantEvents } from "../../../runtime/routes/events-routes.js";
import {
  CHECKPOINT_PREPARE_IPC_METHOD,
  handleCheckpointPrepare,
} from "../checkpoint-ipc-routes.js";

describe(`${CHECKPOINT_PREPARE_IPC_METHOD} IPC route`, () => {
  afterEach(() => {
    clearCheckpointQuiesce();
    closeAllSseSubscriptions();
  });

  test("closes every registered SSE subscription and arms the admission latch", async () => {
    const closed: string[] = [];
    registerSseSubscription(() => closed.push("a"));
    registerSseSubscription(() => closed.push("b"));

    const result = await handleCheckpointPrepare({});

    expect(result).toEqual({ ok: true, disposedSseClients: 2 });
    expect(closed.sort()).toEqual(["a", "b"]);
    expect(isCheckpointQuiesceActive()).toBe(true);
  });

  test("closes headerless (process-typed) SSE subscriptions but leaves in-process hub subscribers untouched", async () => {
    // A genuine in-process subscriber (plugin/worker): subscribes to the hub
    // but never registers as SSE-backed.
    const inProcess = assistantEventHub.subscribe({
      type: "process",
      callback: () => {},
    });
    // A headerless SSE connection: process-typed on the hub, but registered
    // as SSE-backed by the events route.
    const headerlessSse = assistantEventHub.subscribe({
      type: "process",
      callback: () => {},
    });
    registerSseSubscription(() => headerlessSse.dispose());

    const result = await handleCheckpointPrepare({});

    expect(result).toEqual({ ok: true, disposedSseClients: 1 });
    expect(headerlessSse.active).toBe(false);
    expect(inProcess.active).toBe(true);
    inProcess.dispose();
  });

  test("is a no-op with no live SSE subscriptions", async () => {
    const result = await handleCheckpointPrepare({});
    expect(result).toEqual({ ok: true, disposedSseClients: 0 });
  });

  test("unregistered subscriptions are not double-closed", async () => {
    let closes = 0;
    const unregister = registerSseSubscription(() => {
      closes++;
    });
    unregister();

    const result = await handleCheckpointPrepare({});

    expect(result).toEqual({ ok: true, disposedSseClients: 0 });
    expect(closes).toBe(0);
  });

  test("the admission latch rejects new SSE subscriptions with a 503", async () => {
    await handleCheckpointPrepare({});

    expect(() => handleSubscribeAssistantEvents({})).toThrow(
      ServiceUnavailableError,
    );
  });
});
