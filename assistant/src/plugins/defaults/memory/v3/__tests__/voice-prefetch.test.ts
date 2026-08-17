import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OrchestrateResult } from "../orchestrate.js";

type PrepareMemoryV3Turn = (
  conversationId: string,
  turnIndex: number,
  signal?: AbortSignal,
) => Promise<OrchestrateResult | null>;

let prepareImpl: PrepareMemoryV3Turn = async () => null;
const prepareMemoryV3TurnMock = mock<PrepareMemoryV3Turn>(
  (conversationId, turnIndex, signal) =>
    prepareImpl(conversationId, turnIndex, signal),
);
const commitPreparedMemoryV3TurnMock = mock(
  (
    _conversationId: string,
    _turnIndex: number,
    _result: OrchestrateResult,
  ) => {},
);

mock.module("../shadow-plugin.js", () => ({
  prepareMemoryV3Turn: prepareMemoryV3TurnMock,
  commitPreparedMemoryV3Turn: commitPreparedMemoryV3TurnMock,
}));

const {
  cancelVoiceMemoryV3Prefetch,
  hasVoiceMemoryV3PrefetchForTests,
  resetVoiceMemoryV3PrefetchForTests,
  startVoiceMemoryV3Prefetch,
  takeVoiceMemoryV3Prefetch,
} = await import("../voice-prefetch.js");

function result(): OrchestrateResult {
  return {
    selections: [{ slug: "page-a", pinned: false }],
    matchedSections: new Map(),
    lanes: { core: [], hot: [], fresh: [], finder: [] },
  };
}

beforeEach(() => {
  resetVoiceMemoryV3PrefetchForTests();
  prepareImpl = async () => null;
  prepareMemoryV3TurnMock.mockClear();
  commitPreparedMemoryV3TurnMock.mockClear();
});

describe("voice memory-v3 prefetch", () => {
  test("starts without awaiting and commits on the immediately following turn", async () => {
    let resolvePreparation: (value: OrchestrateResult) => void = () => {};
    prepareImpl = () =>
      new Promise((resolve) => {
        resolvePreparation = resolve;
      });

    startVoiceMemoryV3Prefetch("conv-1", 4);

    expect(hasVoiceMemoryV3PrefetchForTests("conv-1")).toBe(true);
    expect(prepareMemoryV3TurnMock).toHaveBeenCalledTimes(1);
    const prepared = takeVoiceMemoryV3Prefetch("conv-1", 5);
    expect(prepared).not.toBeNull();

    let settled = false;
    void prepared!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const selected = result();
    resolvePreparation(selected);
    await expect(prepared!).resolves.toBe(selected);
    expect(commitPreparedMemoryV3TurnMock).toHaveBeenCalledWith(
      "conv-1",
      5,
      selected,
    );
    expect(hasVoiceMemoryV3PrefetchForTests("conv-1")).toBe(false);
  });

  test("does not consume a preparation from the source turn", async () => {
    const selected = result();
    prepareImpl = async () => selected;
    startVoiceMemoryV3Prefetch("conv-1", 7);

    expect(takeVoiceMemoryV3Prefetch("conv-1", 7)).toBeNull();
    expect(hasVoiceMemoryV3PrefetchForTests("conv-1")).toBe(true);

    await expect(takeVoiceMemoryV3Prefetch("conv-1", 8)!).resolves.toBe(
      selected,
    );
    expect(commitPreparedMemoryV3TurnMock).toHaveBeenCalledTimes(1);
  });

  test("cancels unused preparation and forwards its owned abort signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    prepareImpl = async (_conversationId, _turnIndex, signal) => {
      capturedSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    };

    startVoiceMemoryV3Prefetch("conv-1", 2);
    cancelVoiceMemoryV3Prefetch("conv-1");
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(true);
    expect(hasVoiceMemoryV3PrefetchForTests("conv-1")).toBe(false);
    expect(commitPreparedMemoryV3TurnMock).not.toHaveBeenCalled();
  });

  test("transfers cancellation to the escalated turn that consumes it", async () => {
    let capturedSignal: AbortSignal | undefined;
    prepareImpl = async (_conversationId, _turnIndex, signal) => {
      capturedSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    };
    const consumer = new AbortController();
    startVoiceMemoryV3Prefetch("conv-1", 2);
    const prepared = takeVoiceMemoryV3Prefetch("conv-1", 3, consumer.signal);

    consumer.abort(new Error("turn cancelled"));

    await expect(prepared!).resolves.toBeNull();
    expect(capturedSignal?.aborted).toBe(true);
    expect(commitPreparedMemoryV3TurnMock).not.toHaveBeenCalled();
  });

  test("superseding a turn cancels the older preparation", async () => {
    const signals: AbortSignal[] = [];
    prepareImpl = async (_conversationId, _turnIndex, signal) => {
      if (signal) {
        signals.push(signal);
      }
      return null;
    };

    startVoiceMemoryV3Prefetch("conv-1", 1);
    startVoiceMemoryV3Prefetch("conv-1", 2);

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(prepareMemoryV3TurnMock).toHaveBeenCalledTimes(2);
  });
});
