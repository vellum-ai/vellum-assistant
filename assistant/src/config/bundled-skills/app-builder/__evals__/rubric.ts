/**
 * Design rubric definition + the LLM-judge interface.
 *
 * The rubric is the spec we hand an LLM (alongside a render of the built app)
 * to score design quality. The criteria mirror the aesthetic principles the
 * `frontend-design` skill enforces — these are what "whoa, this looks
 * designed" decomposes into.
 *
 * `LLMDesignJudge` is the real interface a live judge implements. Wiring an
 * actual model (screenshot the built app, send rubric + image, parse scores)
 * is out of scope for this scaffolding PR, so we also ship
 * {@link StubDesignJudge}: a deterministic placeholder that lets the full
 * pipeline run and produce a scorecard today. Swap it for a live judge when
 * available — the harness depends only on the {@link DesignJudge} interface.
 */

import type {
  BuildArtifact,
  DesignJudge,
  GoldenPrompt,
  RubricCriterion,
  RubricResult,
  RubricScore,
} from "./types.js";

/** The scored dimensions. Weights need not sum to 1; we normalize. */
export const DESIGN_RUBRIC: readonly RubricCriterion[] = [
  {
    id: "visual-identity",
    label: "Visual identity",
    description:
      "Does the app have a distinctive, domain-matched look (palette, atmosphere) rather than a generic branded template?",
    weight: 2,
  },
  {
    id: "typography",
    label: "Typography & hierarchy",
    description:
      "Clear type scale, readable body, intentional emphasis. Nothing cramped or default-looking.",
    weight: 1,
  },
  {
    id: "layout",
    label: "Layout & composition",
    description:
      "Balanced spacing, aligned grids, sensible density. Looks composed, not auto-generated.",
    weight: 1,
  },
  {
    id: "polish",
    label: "Polish & micro-interactions",
    description:
      "Empty states, hover/focus states, motion, and finishing touches that make it feel crafted.",
    weight: 1,
  },
  {
    id: "prompt-fit",
    label: "Prompt fit",
    description:
      "Does the result actually satisfy what the user asked for, including implied features?",
    weight: 2,
  },
] as const;

/** Build the prompt text a live judge would send to the model. */
export function buildJudgePrompt(prompt: GoldenPrompt): string {
  const criteria = DESIGN_RUBRIC.map(
    (c) => `- ${c.label} (id: ${c.id}): ${c.description}`,
  ).join("\n");
  return [
    "You are a senior product designer scoring a generated app.",
    `The user asked: "${prompt.prompt}"`,
    "Score each criterion 1-5 (5 = excellent) and give a one-line rationale.",
    "Criteria:",
    criteria,
    'Respond as JSON: {"scores":[{"criterionId","score","rationale"}]}.',
  ].join("\n");
}

/** Normalize per-criterion scores (1..5) into a weighted 0..1 overall. */
export function scoreToOverall(scores: RubricScore[]): number {
  const byId = new Map(scores.map((s) => [s.criterionId, s.score]));
  let weighted = 0;
  let totalWeight = 0;
  for (const c of DESIGN_RUBRIC) {
    const raw = byId.get(c.id);
    if (raw === undefined) continue;
    // map 1..5 -> 0..1
    weighted += ((raw - 1) / 4) * c.weight;
    totalWeight += c.weight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

/**
 * The interface a live LLM judge implements. Documented seam: an implementation
 * renders `artifact` to an image, sends {@link buildJudgePrompt} + the image to
 * a model, parses the JSON scores, and calls {@link scoreToOverall}.
 */
export type LLMDesignJudge = DesignJudge;

/**
 * Deterministic stand-in so the pipeline runs without a live model. It does NOT
 * judge design — it derives a stable pseudo-score from the artifact so runs are
 * reproducible. Replace with a live judge to get real design signal.
 */
export class StubDesignJudge implements DesignJudge {
  async score(
    artifact: BuildArtifact,
    _prompt: GoldenPrompt,
  ): Promise<RubricResult> {
    const sourceLen = Object.values(artifact.sourceFiles).join("").length;
    const scores: RubricScore[] = DESIGN_RUBRIC.map((c, i) => ({
      criterionId: c.id,
      // Stable, content-derived placeholder in the 3-5 band.
      score: 3 + ((sourceLen + i) % 3),
      rationale: "stub judge — no live model wired",
    }));
    return { scores, overall: scoreToOverall(scores) };
  }
}
