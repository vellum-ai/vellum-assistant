import { describe, expect, test } from "bun:test";

import {
  ALL_RECALL_SOURCES,
  DEFAULT_RECALL_MAX_RESULTS,
  normalizeRecallInput,
  normalizeRecallMaxResults,
  normalizeRecallSources,
  RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE,
  RECALL_SOURCE_ROUNDS_BY_DEPTH,
  RECALL_TOTAL_EVIDENCE_TEXT_CAP,
} from "../memory/context-search/limits.js";
import type {
  RecallInput,
  RecallSource,
  RecallSourceAdapter,
} from "../memory/context-search/types.js";

describe("normalizeRecallInput", () => {
  test("defaults omitted sources, max results, and depth", () => {
    const normalized = normalizeRecallInput({ query: "project notes" });

    expect(normalized).toEqual({
      query: "project notes",
      sources: [...ALL_RECALL_SOURCES],
      maxResults: DEFAULT_RECALL_MAX_RESULTS,
      depth: "standard",
      sourceRounds: 2,
    });
  });

  test("clamps max results to the supported range", () => {
    expect(normalizeRecallMaxResults(0)).toBe(1);
    expect(normalizeRecallMaxResults(-10)).toBe(1);
    expect(normalizeRecallMaxResults(21)).toBe(20);
    expect(normalizeRecallMaxResults(2.9)).toBe(2);
    expect(normalizeRecallMaxResults(Number.NaN)).toBe(
      DEFAULT_RECALL_MAX_RESULTS,
    );
  });

  test("de-duplicates sources while preserving first-seen order", () => {
    expect(
      normalizeRecallSources(["workspace", "memory", "workspace", "pkb"]),
    ).toEqual(["workspace", "memory", "pkb"]);
  });

  test("rejects unknown sources before adapters are run", async () => {
    let adapterRan = false;
    const adapter: RecallSourceAdapter = {
      source: "memory",
      async search() {
        adapterRan = true;
        return { evidence: [] };
      },
    };

    expect(() =>
      normalizeRecallInput({
        query: "deployment",
        sources: ["memory", "calendar"] as unknown as RecallSource[],
      }),
    ).toThrow("Unknown recall source: calendar");

    expect(adapterRan).toBe(false);
    expect(adapter.source).toBe("memory");
  });

  test("maps depth to source-round budgets", () => {
    expect(RECALL_SOURCE_ROUNDS_BY_DEPTH).toEqual({
      fast: 1,
      standard: 2,
      deep: 3,
    });

    const cases: Array<[NonNullable<RecallInput["depth"]>, number]> = [
      ["fast", 1],
      ["standard", 2],
      ["deep", 3],
    ];

    for (const [depth, sourceRounds] of cases) {
      expect(normalizeRecallInput({ query: "notes", depth }).sourceRounds).toBe(
        sourceRounds,
      );
    }
  });

  test("exports evidence text caps", () => {
    expect(RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE).toBeGreaterThan(0);
    expect(RECALL_TOTAL_EVIDENCE_TEXT_CAP).toBeGreaterThan(
      RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE,
    );
  });
});
