/**
 * Best-effort static plan-adherence checks.
 *
 * "Plan adherence" asks: did the build actually use the design tokens and
 * files it was supposed to? We can't run the app here, so we do cheap static
 * checks over the produced source — token presence and file presence.
 *
 * Expectations come from the build's own plan when available (planner/worker
 * emits one), otherwise from {@link DEFAULT_EXPECTATIONS} keyed by prompt, then
 * a generic baseline. This keeps the check meaningful for the single-model
 * variant (which has no explicit plan) while letting the v2 flow be graded
 * against what it claimed it would do.
 */

import type {
  BuildArtifact,
  GoldenPrompt,
  PlanAdherenceResult,
  PlanExpectations,
} from "./types.js";

/** Tokens every well-formed app should lean on (design-system surface). */
const BASELINE_TOKENS = ["--v-bg", "--v-text", "--v-accent"];

/** The multi-file (formatVersion 2) scaffold every app should produce. */
const BASELINE_FILES = ["src/main.tsx"];

/**
 * Per-prompt expectations layered on top of the baseline. Best-effort — these
 * encode "a faithful X build tends to use Y", not a hard spec.
 */
export const DEFAULT_EXPECTATIONS: Record<string, PlanExpectations> = {
  "habit-tracker": {
    designTokens: [...BASELINE_TOKENS, "--v-success"],
    files: BASELINE_FILES,
  },
  "finance-dashboard": {
    designTokens: [...BASELINE_TOKENS, "--v-surface"],
    files: BASELINE_FILES,
  },
  "slide-deck": {
    designTokens: [...BASELINE_TOKENS],
    files: BASELINE_FILES,
  },
  calculator: {
    designTokens: [...BASELINE_TOKENS, "--v-font-mono"],
    files: BASELINE_FILES,
  },
};

function resolveExpectations(
  artifact: BuildArtifact,
  prompt: GoldenPrompt,
): PlanExpectations {
  return (
    artifact.plan ??
    prompt.expects ??
    DEFAULT_EXPECTATIONS[prompt.id] ?? {
      designTokens: BASELINE_TOKENS,
      files: BASELINE_FILES,
    }
  );
}

function coverage<T>(expected: T[], isPresent: (item: T) => boolean) {
  if (expected.length === 0) return { fraction: 1, missing: [] as T[] };
  const missing = expected.filter((item) => !isPresent(item));
  return {
    fraction: (expected.length - missing.length) / expected.length,
    missing,
  };
}

export function checkPlanAdherence(
  artifact: BuildArtifact,
  prompt: GoldenPrompt,
): PlanAdherenceResult {
  const expected = resolveExpectations(artifact, prompt);
  const allSource = Object.values(artifact.sourceFiles).join("\n");
  const presentFiles = new Set(Object.keys(artifact.sourceFiles));

  const tokens = coverage(expected.designTokens, (t) => allSource.includes(t));
  const files = coverage(expected.files, (f) => presentFiles.has(f));

  return {
    tokenCoverage: tokens.fraction,
    fileCoverage: files.fraction,
    missingTokens: tokens.missing,
    missingFiles: files.missing,
  };
}
