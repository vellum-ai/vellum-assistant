/**
 * Per-unit runner for the LongMemEval-V2 benchmark.
 *
 * Wires the four pieces shipped in earlier PRs into a single
 * `EvalRunResult`-shaped execution:
 *
 *   - `loadLongMemEvalV2`        — `BenchmarkItem`s with eval_function strings
 *   - `openTrajectories` +       — per-question workspace file writes
 *      `materializeWorkspaceFiles`
 *   - `runIngestAsk`             — two-conversation runner (ingest → ask)
 *   - `evalFromSpec`             — dispatched evaluator (deterministic or LLM)
 *
 * Lifecycle parity with `runEvalOnce`:
 *   - same `EvalRunResult` shape (so the CLI loop and the report server
 *     don't need a second branch to consume V2 results)
 *   - same artifact layout under `.runs/<runId>/` via the existing
 *     `runArtifacts` helpers (`run.json`, `metrics.json`, `transcript.json`,
 *     `assistant-events.json`, `progress.ndjson`)
 *   - same wrapped progress reporter + heartbeat ticker, shared with
 *     `runEvalOnce` via `createRunProgressLifecycle` (the PR-8 extract
 *     that replaced the inlined `// PR-6 follow-up` blocks)
 *
 * Out of scope for PR-6 / PR-8 (still deferred):
 *   - usage / cost telemetry. `runIngestAsk` doesn't return per-call
 *     usage and the V2 judges call OpenAI directly (no provider wrapper).
 *     Tracked as a PR-9 candidate.
 */
import {
  type EvalRunResult,
  markErrorAsReportedToProgress,
} from "../../../src/lib/runner/run-once";
import type { EvalProgressReporter } from "../../../src/lib/runner/progress";
import { createRunProgressLifecycle } from "../../../src/lib/runner/progress-lifecycle";
import {
  ensureRunArtifacts,
  type MetricResult,
  updateRunMetadata,
  writeRunMetadata,
  writeTranscript,
} from "../../../src/lib/metrics";
import type { Profile } from "../../../src/lib/profile";
import type { TranscriptTurn } from "../../../src/lib/transcript";
import { runIngestAsk } from "../../../src/lib/runner/run-ingest-ask";
import { writeFile } from "node:fs/promises";

import { type EvalOverrides, type EvalResult, evalFromSpec } from "./judge";
import type { BenchmarkItem } from "./loader";
import {
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_TRAJECTORY_DIR,
  materializeWorkspaceFiles,
} from "./trajectories";
import type { TrajectoryReader } from "./trajectory-reader";

export interface RunLongMemEvalV2UnitInput {
  /** Profile to hatch. */
  profile: Profile;
  /** The V2 question to run, already joined to its haystack. */
  item: BenchmarkItem;
  /**
   * Open handle over `trajectories.jsonl`. The caller opens it once
   * per `evals run` invocation and passes it through here so we
   * neither re-scan the ~1 GB file per question nor hold a gigabyte
   * of records resident across the whole run.
   */
  trajectoryReader: TrajectoryReader;
  /** Logical run id; namespaced as `<benchmark>-<profile>-<questionId>-<ts>`. */
  runId: string;
  /** Logical session id for the originating `evals run` invocation. */
  sessionId?: string;
  /** Optional human-readable session label. */
  sessionLabel?: string;
  /** Caller's progress reporter. We tee every event to disk + heartbeat. */
  progress?: EvalProgressReporter;
  /**
   * Quiet timeout (ms) for ingest + question event drains in
   * `runIngestAsk`. Defaults to 30s — same default the underlying
   * runner uses, surfaced here so the harness can override per-run.
   */
  quietMs?: number;
  /** Caller-side overrides applied after the per-question spec kwargs. */
  judgeOverrides?: EvalOverrides;
}

/**
 * Compose the conversation-A "ingest" prompt. Deliberately neutral —
 * it points at the staged files and asks the agent to do whatever its
 * memory layer does. We don't reveal the question text here; the
 * question turn is conversation B.
 */
function buildIngestMessage(trajectoryCount: number): string {
  return [
    `I have staged ${trajectoryCount} trajectory file(s) into your workspace at`,
    `\`${WORKSPACE_TRAJECTORY_DIR}/\` (one JSON file per trajectory, named`,
    `\`<trajectory_id>.json\`).`,
    `An index of the files in haystack order lives at \`${WORKSPACE_MANIFEST_PATH}\`.`,
    "",
    "Please read through these trajectories and remember whatever you think",
    "will be useful for answering a follow-up question about them. Use",
    "whatever memory tools you have. When you are done ingesting, reply with",
    'a single line: "Ready."',
  ]
    .join(" \n")
    .trim();
}

/**
 * Compose the conversation-B "ask" prompt. Verbatim question text — no
 * scaffolding that would leak the eval_function's grading rubric.
 */
function buildQuestionMessage(question: string): string {
  return question;
}

function metricFromEvalResult(
  evalResult: EvalResult,
  item: BenchmarkItem,
): MetricResult {
  return {
    name: "longmemeval-v2-judge",
    score: evalResult.label ? 1 : 0,
    reason: evalResult.reason || undefined,
    metadata: {
      function: evalResult.function,
      ability: item.ability,
      questionId: item.questionId,
    },
  };
}

/**
 * Runs a single LongMemEval-V2 question against a profile.
 *
 * Mirrors `runEvalOnce`'s lifecycle (artifacts → metadata(running) →
 * progress events → metric → metadata(completed/failed)) so the
 * dispatcher in `commands/run.ts` can treat both code paths
 * interchangeably.
 */
export async function runLongMemEvalV2Unit(
  input: RunLongMemEvalV2UnitInput,
): Promise<EvalRunResult> {
  const sessionId = input.sessionId ?? input.runId;
  const sessionLabel = input.sessionLabel;

  // Shared with `runEvalOnce` — wrapped reporter + 5s heartbeat ticker.
  // `dispose()` in the `finally` below stops the ticker (idempotent).
  const { progress, dispose } = createRunProgressLifecycle({
    runId: input.runId,
    userProgress: input.progress,
  });

  const startedAt = new Date().toISOString();

  let artifactDir = "";
  try {
    progress({
      step: "artifacts",
      status: "start",
      message: "Preparing run artifacts",
      detail: input.runId,
    });
    const artifacts = await ensureRunArtifacts(input.runId);
    artifactDir = artifacts.runDir;
    progress({
      step: "artifacts",
      status: "done",
      message: "Run artifacts ready",
      detail: artifactDir,
    });

    await writeRunMetadata(input.runId, {
      runId: input.runId,
      sessionId,
      sessionLabel,
      profileId: input.profile.id,
      testId: input.item.questionId,
      status: "running",
      startedAt,
      artifactDir,
    });

    // Stage trajectory writes before handing them to the runner. A
    // throw from the materializer (missing trajectory id) means the
    // dataset is corrupt — surfacing through the structured failure
    // path is the right thing.
    progress({
      step: "setup",
      status: "start",
      message: "Materializing trajectory files",
      detail: `${input.item.trajectoryIds.length} trajectories`,
    });
    const inputs = await materializeWorkspaceFiles(
      input.item,
      input.trajectoryReader,
    );
    progress({
      step: "setup",
      status: "done",
      message: "Trajectory files prepared",
      detail: `${inputs.length} writes`,
    });

    const ingestMessage = buildIngestMessage(input.item.trajectoryIds.length);
    const questionMessage = buildQuestionMessage(input.item.question);

    progress({
      step: "send",
      status: "start",
      message: "Running ingest → ask",
      detail: input.item.questionId,
    });
    const ingestAskResult = await runIngestAsk({
      profile: input.profile,
      runId: input.runId,
      inputs,
      ingestMessage,
      questionMessage,
      quietMs: input.quietMs,
    });
    progress({
      step: "send",
      status: "done",
      message: "Hypothesis captured",
      detail: `${ingestAskResult.hypothesis.length} chars`,
    });

    // Build a three-turn transcript: ingest prompt → question prompt →
    // assistant hypothesis. This is the deliberately-coarse Phase 1
    // shape — per-event transcript reconstruction lives with the full
    // event capture in a later PR.
    const transcriptStamp = new Date().toISOString();
    const transcript: TranscriptTurn[] = [
      { role: "simulator", content: ingestMessage, emittedAt: transcriptStamp },
      {
        role: "simulator",
        content: questionMessage,
        emittedAt: transcriptStamp,
      },
      {
        role: "assistant",
        content: ingestAskResult.hypothesis,
        emittedAt: transcriptStamp,
      },
    ];
    await writeTranscript(input.runId, transcript);

    // Persist the question-turn events. We deliberately drop the
    // ingest-turn events on the floor for now — they're the agent's
    // private memory-formation work, and surfacing them in the same
    // file as the question-turn events would confuse the report
    // server's "assistant said this in response to the question" view.
    await writeFile(
      artifacts.assistantEventsPath,
      JSON.stringify(ingestAskResult.questionEvents, null, 2),
    );

    progress({
      step: "metrics",
      status: "start",
      message: "Grading hypothesis",
      detail: input.item.evalFunction,
    });
    const evalResult = await evalFromSpec(
      input.item.evalFunction,
      {
        prediction: ingestAskResult.hypothesis,
        answer: input.item.answer,
        questionItem: { question: input.item.question },
      },
      input.judgeOverrides ?? {},
    );
    const metric = metricFromEvalResult(evalResult, input.item);
    await writeFile(artifacts.metricsPath, JSON.stringify([metric], null, 2));
    progress({
      step: "metrics",
      status: "done",
      message: `Judge label: ${evalResult.label}`,
      detail: evalResult.function,
    });

    progress({
      step: "result",
      status: "done",
      message: `Run completed: ${metric.name}=${metric.score.toFixed(2)}`,
      detail: input.item.questionId,
    });

    await updateRunMetadata(input.runId, (current) =>
      current
        ? {
            ...current,
            status: "completed",
            completedAt: new Date().toISOString(),
          }
        : undefined,
    );

    return {
      runId: input.runId,
      profileId: input.profile.id,
      testId: input.item.questionId,
      artifactDir,
      transcript,
      metrics: [metric],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress({
      step: "shutdown",
      status: "error",
      message,
    });
    // Stamp the error so the outer `commands/run.ts` loop's
    // `wasErrorReportedToProgress` check stays quiet — otherwise the
    // CLI prints a second diagnostic line on top of the structured
    // progress event we already emitted above.
    markErrorAsReportedToProgress(err);
    // Mark the run as failed before re-throwing so the report server
    // doesn't see a stuck "running" status.
    await updateRunMetadata(input.runId, (current) =>
      current
        ? {
            ...current,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: message,
          }
        : undefined,
    ).catch(() => undefined);
    throw err;
  } finally {
    dispose();
  }
}
