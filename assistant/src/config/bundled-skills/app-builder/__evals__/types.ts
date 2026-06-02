/**
 * Shared types for the app-builder golden-set eval harness.
 *
 * The harness measures whether a given build *variant* (the current
 * single-model skill, or the future tiered planner/worker flow) produces
 * good apps. It scores three independent dimensions per build:
 *
 *  1. compile — did the produced source actually compile?
 *  2. plan-adherence — did the output use the design tokens / files the
 *     variant said it would? (best-effort static checks)
 *  3. design rubric — an LLM-scored aesthetic/quality judgment.
 *
 * Results roll up into a {@link Scorecard} that is shaped for A/B comparison
 * between variants, with latency/cost columns left ready for PR 7 telemetry.
 */

/** A single fixed prompt in the golden set. */
export interface GoldenPrompt {
  /** Stable id, used as a column key in the scorecard. */
  id: string;
  /** Human-readable label, e.g. "Habit tracker". */
  label: string;
  /** The user request fed to the build variant verbatim. */
  prompt: string;
  /**
   * Design tokens / file paths we expect a faithful build to use. Drives the
   * best-effort plan-adherence static checks. Optional per-prompt overrides;
   * defaults live in {@link plan-adherence.ts}.
   */
  expects?: PlanExpectations;
}

/** What a faithful build is expected to contain (static, best-effort). */
export interface PlanExpectations {
  /** Design-system CSS variables expected to appear, e.g. "--v-accent". */
  designTokens: string[];
  /** Source file paths expected to exist, e.g. "src/main.tsx". */
  files: string[];
}

/** The artifact a build variant produces for a prompt. */
export interface BuildArtifact {
  /** Map of file path -> file contents (the TSX/CSS the variant wrote). */
  sourceFiles: Record<string, string>;
  /**
   * The plan the variant committed to, if any. The planner/worker flow emits
   * one; the single-model baseline may leave this undefined. When present, it
   * lets plan-adherence check intent vs. output rather than a fixed default.
   */
  plan?: PlanExpectations;
}

/** Identifies which build flow produced a result. */
export type Variant = "single-model" | "planner-worker";

/** Compile-check outcome for one build. */
export interface CompileResult {
  ok: boolean;
  errors: string[];
}

/** Plan-adherence outcome for one build (best-effort static analysis). */
export interface PlanAdherenceResult {
  /** 0..1 fraction of expected design tokens found in the output. */
  tokenCoverage: number;
  /** 0..1 fraction of expected files present in the output. */
  fileCoverage: number;
  /** Tokens/files that were expected but missing (for debugging). */
  missingTokens: string[];
  missingFiles: string[];
}

/** A single rubric dimension's definition. */
export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  /** Relative weight when computing the overall design score. */
  weight: number;
}

/** An LLM's score for one rubric criterion. */
export interface RubricScore {
  criterionId: string;
  /** 1..5, where 5 is excellent. */
  score: number;
  rationale: string;
}

/** Full design-rubric judgment for one build. */
export interface RubricResult {
  scores: RubricScore[];
  /** Weighted overall, normalized to 0..1. */
  overall: number;
}

/** Telemetry placeholders, to be populated by PR 7. */
export interface BuildTelemetry {
  latencyMs?: number;
  costUsd?: number;
}

/** Everything we learned about one (variant, prompt) build. */
export interface BuildResult {
  variant: Variant;
  promptId: string;
  compile: CompileResult;
  planAdherence: PlanAdherenceResult;
  rubric: RubricResult;
  telemetry: BuildTelemetry;
}

/** One column of the scorecard: a single variant's aggregate + per-prompt rows. */
export interface ScorecardColumn {
  variant: Variant;
  rows: BuildResult[];
  /** Fraction of builds that compiled. */
  compileRate: number;
  /** Mean token coverage across builds. */
  meanTokenCoverage: number;
  /** Mean file coverage across builds. */
  meanFileCoverage: number;
  /** Mean design rubric overall across builds. */
  meanDesignScore: number;
  /** Mean latency, when telemetry is present. */
  meanLatencyMs?: number;
  /** Mean cost, when telemetry is present. */
  meanCostUsd?: number;
}

/** The A/B-comparable result of an eval run. */
export interface Scorecard {
  generatedAt: string;
  promptSetSize: number;
  columns: ScorecardColumn[];
}

/**
 * Drives a single app build end-to-end for one prompt under one variant.
 *
 * This is the real seam between the harness and a build flow. The current
 * single-model skill and the future planner/worker flow each implement this.
 * See {@link build-driver.ts} for the baseline stub.
 */
export interface AppBuildDriver {
  readonly variant: Variant;
  build(prompt: GoldenPrompt): Promise<BuildArtifact>;
}

/**
 * Scores a build's design quality. The real implementation calls an LLM with
 * the rubric and a render/screenshot of the app; the harness ships a
 * deterministic stub so the pipeline runs without a live model. See
 * {@link rubric.ts}.
 */
export interface DesignJudge {
  score(artifact: BuildArtifact, prompt: GoldenPrompt): Promise<RubricResult>;
}
