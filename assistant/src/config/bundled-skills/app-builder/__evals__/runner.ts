/**
 * The eval runner: drives each (variant, prompt) build, scores it on the three
 * dimensions, and rolls the results up into an A/B-comparable {@link Scorecard}.
 */

import { checkPlanAdherence } from "./plan-adherence.js";
import { StubDesignJudge } from "./rubric.js";
import type {
  AppBuildDriver,
  BuildArtifact,
  BuildResult,
  CompileResult,
  DesignJudge,
  GoldenPrompt,
  Scorecard,
  ScorecardColumn,
} from "./types.js";

/**
 * Compiles a build's source. The default is a lightweight static sanity check
 * so the harness runs anywhere; a live runner can pass the real esbuild-backed
 * `compileApp` (write files to a temp dir, call it, map the result).
 */
export type CompileFn = (artifact: BuildArtifact) => Promise<CompileResult>;

const defaultCompile: CompileFn = async (artifact) => {
  const errors: string[] = [];
  const files = Object.entries(artifact.sourceFiles);
  if (files.length === 0) errors.push("no source files produced");
  for (const [path, contents] of files) {
    if (!contents.trim()) errors.push(`${path}: empty file`);
    // Cheap balance check — catches the most common truncation failures.
    const open = (contents.match(/[({[]/g) ?? []).length;
    const close = (contents.match(/[)}\]]/g) ?? []).length;
    if (open !== close) errors.push(`${path}: unbalanced brackets`);
  }
  return { ok: errors.length === 0, errors };
};

export interface RunnerOptions {
  prompts: readonly GoldenPrompt[];
  drivers: readonly AppBuildDriver[];
  /** Design judge; defaults to the deterministic stub. */
  judge?: DesignJudge;
  /** Compile check; defaults to a lightweight static check. */
  compile?: CompileFn;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function defined(xs: (number | undefined)[]): number[] {
  return xs.filter((x): x is number => x !== undefined);
}

function summarize(
  variant: AppBuildDriver["variant"],
  rows: BuildResult[],
): ScorecardColumn {
  const latencies = defined(rows.map((r) => r.telemetry.latencyMs));
  const costs = defined(rows.map((r) => r.telemetry.costUsd));
  return {
    variant,
    rows,
    compileRate: mean(rows.map((r) => (r.compile.ok ? 1 : 0))),
    meanTokenCoverage: mean(rows.map((r) => r.planAdherence.tokenCoverage)),
    meanFileCoverage: mean(rows.map((r) => r.planAdherence.fileCoverage)),
    meanDesignScore: mean(rows.map((r) => r.rubric.overall)),
    meanLatencyMs: latencies.length ? mean(latencies) : undefined,
    meanCostUsd: costs.length ? mean(costs) : undefined,
  };
}

export async function runEvals(options: RunnerOptions): Promise<Scorecard> {
  const judge = options.judge ?? new StubDesignJudge();
  const compile = options.compile ?? defaultCompile;

  const columns: ScorecardColumn[] = [];
  for (const driver of options.drivers) {
    const rows: BuildResult[] = [];
    for (const prompt of options.prompts) {
      const artifact = await driver.build(prompt);
      rows.push({
        variant: driver.variant,
        promptId: prompt.id,
        compile: await compile(artifact),
        planAdherence: checkPlanAdherence(artifact, prompt),
        rubric: await judge.score(artifact, prompt),
        // Latency/cost left empty — populated once PR 7 telemetry lands.
        telemetry: {},
      });
    }
    columns.push(summarize(driver.variant, rows));
  }

  return {
    generatedAt: new Date().toISOString(),
    promptSetSize: options.prompts.length,
    columns,
  };
}
