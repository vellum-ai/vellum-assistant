import { describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/types.js";
import type { OracleTurn } from "../harness/oracle.js";
import type { ReconstructedInput } from "../harness/replay-input.js";
import type {
  RetrievalInput,
  RetrievalOutput,
  Retriever,
} from "../harness/retriever.js";
import { runComparison } from "../harness/runner.js";

const ZERO_CONFIG = {
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
};

function oracleTurn(
  conversationId: string,
  turn: number,
  groundTruthSlugs: string[],
): OracleTurn {
  return {
    conversationId,
    turn,
    anchorMessageId: `${conversationId}-m${turn}`,
    anchorCreatedAt: turn * 100,
    groundTruthSlugs,
    loggedConfig: ZERO_CONFIG,
    createdAt: turn * 100,
  };
}

const STUB_INPUT: RetrievalInput = {
  workspaceDir: "/tmp/ws",
  recentTurnPairs: [{ assistantMessage: "", userMessage: "hi" }],
  nowText: "",
  priorEverInjected: [],
  config: {} as unknown as AssistantConfig,
};

const STUB_RECONSTRUCTED: ReconstructedInput = {
  input: STUB_INPUT,
  meta: {
    windowPairs: 1,
    pairsReconstructed: 1,
    priorEverInjectedCount: 0,
    nowReconstructedFromCurrent: true,
  },
};

function fixedRetriever(name: string, selected: string[]): Retriever {
  return {
    name,
    retrieve: async (): Promise<RetrievalOutput> => ({
      selectedSlugs: selected,
      sourceBySlug: new Map(selected.map((s): [string, string] => [s, name])),
    }),
  };
}

describe("harness/runner runComparison", () => {
  test("scores each retriever against ground truth across turns", async () => {
    const report = await runComparison({
      retrievers: [
        fixedRetriever("router", ["a", "b"]),
        fixedRetriever("loop", ["a", "c"]),
      ],
      oracleTurns: [
        oracleTurn("c1", 1, ["a", "b"]),
        oracleTurn("c1", 2, ["a"]),
      ],
      reconstruct: async () => STUB_RECONSTRUCTED,
      ks: [5],
    });

    expect(report.turnsConsidered).toBe(2);
    expect(report.turnsScored).toBe(2);
    expect(report.turnsSkipped).toBe(0);

    const router = report.retrievers.find((r) => r.name === "router");
    const loop = report.retrievers.find((r) => r.name === "loop");
    // router recovers all ground truth on both turns → mean recall 1
    expect(router?.aggregate.meanRecallAtK[5]).toBeCloseTo(1);
    // loop: turn 1 = 1/2, turn 2 = 1/1 → mean 0.75
    expect(loop?.aggregate.meanRecallAtK[5]).toBeCloseTo(0.75);
  });

  test("threads the abort signal into each retriever's input", async () => {
    const controller = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const capturingRetriever: Retriever = {
      name: "router",
      retrieve: async (input): Promise<RetrievalOutput> => {
        seenSignals.push(input.signal);
        return { selectedSlugs: [], sourceBySlug: new Map() };
      },
    };

    // Fresh reconstructed input per turn so we exercise the per-turn assignment.
    await runComparison({
      retrievers: [capturingRetriever],
      oracleTurns: [oracleTurn("c1", 1, ["a"])],
      reconstruct: async () => ({
        ...STUB_RECONSTRUCTED,
        input: { ...STUB_INPUT },
      }),
      ks: [5],
      signal: controller.signal,
    });

    expect(seenSignals).toEqual([controller.signal]);
  });

  test("skips turns whose reconstruction returns null", async () => {
    const report = await runComparison({
      retrievers: [fixedRetriever("router", ["a"])],
      oracleTurns: [oracleTurn("c1", 1, ["a"]), oracleTurn("c1", 2, ["a"])],
      reconstruct: async (turn) =>
        turn.turn === 2 ? null : STUB_RECONSTRUCTED,
      ks: [5],
    });

    expect(report.turnsScored).toBe(1);
    expect(report.turnsSkipped).toBe(1);
    expect(report.perTurn.length).toBe(1);
    expect(report.perTurn[0]?.turn).toBe(1);
  });
});
