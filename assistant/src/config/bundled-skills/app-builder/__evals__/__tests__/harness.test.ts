import { describe, expect, test } from "bun:test";

import { StubBuildDriver } from "../build-driver.js";
import { checkPlanAdherence } from "../plan-adherence.js";
import { GOLDEN_PROMPTS } from "../prompts.js";
import { DESIGN_RUBRIC, scoreToOverall, StubDesignJudge } from "../rubric.js";
import { runEvals } from "../runner.js";
import type { BuildArtifact } from "../types.js";

describe("app-builder eval harness", () => {
  test("ships a non-empty fixed prompt set with unique ids", () => {
    expect(GOLDEN_PROMPTS.length).toBeGreaterThan(0);
    const ids = GOLDEN_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("scoreToOverall maps a perfect rubric to 1 and a floor to 0", () => {
    const perfect = DESIGN_RUBRIC.map((c) => ({
      criterionId: c.id,
      score: 5,
      rationale: "",
    }));
    const floor = DESIGN_RUBRIC.map((c) => ({
      criterionId: c.id,
      score: 1,
      rationale: "",
    }));
    expect(scoreToOverall(perfect)).toBeCloseTo(1);
    expect(scoreToOverall(floor)).toBeCloseTo(0);
  });

  test("plan-adherence rewards expected tokens/files and flags misses", async () => {
    const prompt = GOLDEN_PROMPTS[0];
    const good = await new StubBuildDriver("single-model").build(prompt);
    const goodResult = checkPlanAdherence(good, prompt);
    expect(goodResult.fileCoverage).toBe(1);
    expect(goodResult.tokenCoverage).toBeGreaterThan(0);

    const empty: BuildArtifact = { sourceFiles: {} };
    const emptyResult = checkPlanAdherence(empty, prompt);
    expect(emptyResult.fileCoverage).toBe(0);
    expect(emptyResult.missingFiles.length).toBeGreaterThan(0);
  });

  test("stub design judge returns one score per rubric criterion", async () => {
    const prompt = GOLDEN_PROMPTS[0];
    const artifact = await new StubBuildDriver("single-model").build(prompt);
    const result = await new StubDesignJudge().score(artifact, prompt);
    expect(result.scores.length).toBe(DESIGN_RUBRIC.length);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(1);
  });

  test("runEvals produces an A/B scorecard with one column per driver", async () => {
    const card = await runEvals({
      prompts: GOLDEN_PROMPTS,
      drivers: [
        new StubBuildDriver("single-model"),
        new StubBuildDriver("planner-worker"),
      ],
    });

    expect(card.promptSetSize).toBe(GOLDEN_PROMPTS.length);
    expect(card.columns.map((c) => c.variant)).toEqual([
      "single-model",
      "planner-worker",
    ]);
    for (const col of card.columns) {
      expect(col.rows.length).toBe(GOLDEN_PROMPTS.length);
      expect(col.compileRate).toBe(1); // stub scaffold always compiles
      // Telemetry columns are present but empty until PR 7 wires them.
      expect(col.meanLatencyMs).toBeUndefined();
      expect(col.meanCostUsd).toBeUndefined();
    }
  });
});
