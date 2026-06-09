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
 *     `assistant-events.json`, `ingest-assistant-events.json`,
 *     `progress.ndjson`)
 *   - same wrapped progress reporter + heartbeat ticker, shared with
 *     `runEvalOnce` via `createRunProgressLifecycle` (the PR-8 extract
 *     that replaced the inlined `// PR-6 follow-up` blocks)
 *   - same usage.json shape, fed through `summarizeAssistantUsage` over
 *     both conversations' events plus the LLM judge's normalized usage
 *     record when present (PR-9). The agent half rides on
 *     `event.message.usage` exactly the way `runEvalOnce` ingests it;
 *     the judge half is synthesized as a single fake usage event from
 *     `EvalResult.usage` and folded into the same summarizer pass so
 *     the per-model totals + cost diagnostics + cost status all stay
 *     centralized in one place.
 */
import { writeFile } from "node:fs/promises";

import type { AgentEvent } from "../../../src/lib/adapter";
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
  writeIngestAssistantEvents,
  writeRunMetadata,
  writeTranscript,
  writeUsage,
} from "../../../src/lib/metrics";
import type { Profile } from "../../../src/lib/profile";
import type { TranscriptTurn } from "../../../src/lib/transcript";
import {
  IngestAskError,
  runIngestAsk,
} from "../../../src/lib/runner/run-ingest-ask";
import { summarizeAssistantUsage } from "../../../src/lib/usage";

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
  /**
   * `process.argv` captured at the top of the originating `evals run`.
   * Forwarded onto every `RunMetadata` so the report UI can show the
   * exact command that produced the run. Undefined when invoked
   * programmatically.
   */
  cliArgv?: string[];
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
 * Compose the conversation-A "ingest" prompt. Deliberately
 * question-blind — it points at the staged files and tells the agent to
 * deliberately commit what matters to memory *now*, in this turn, then
 * emit the completion sentinel. We don't reveal the question text here;
 * the question turn is a fresh conversation B.
 *
 * The explicit "commit using your memory tools, then reply Ready." is the
 * portable contract the runner relies on: for any species whose memory
 * write is synchronous within the turn, committing here means the facts
 * persist into conversation B with no out-of-band "await memory" step.
 * Memory-less baselines simply have nothing to commit and still answer.
 */
function buildIngestMessage(trajectoryCount: number): string {
  return [
    `I have staged ${trajectoryCount} trajectory file(s) into your workspace at`,
    `\`${WORKSPACE_TRAJECTORY_DIR}/\` (one JSON file per trajectory, named`,
    `\`<trajectory_id>.json\`).`,
    `An index of the files in haystack order lives at \`${WORKSPACE_MANIFEST_PATH}\`.`,
    "",
    "Read through every trajectory and commit everything worth remembering to",
    "your long-term memory using your memory tools — now, during this turn.",
    "Afterwards I will ask follow-up questions in a brand-new conversation that",
    "will NOT have access to this chat history or these files: only what you",
    "have saved to memory will be available to you then. Save as you go and do",
    "not rely on this conversation persisting.",
    "",
    "When — and only when — you have finished reading all trajectories AND",
    'committed what matters to memory, reply with a single line: "Ready."',
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
 * Roll the agent's two conversation event streams + the LLM judge's
 * usage record (if any) into the same `usage.json` shape `runEvalOnce`
 * writes. Sharing `summarizeAssistantUsage` keeps token sums, cost
 * pricing, and cost diagnostics consistent across the two runner shapes
 * — Phase 2's cost/latency Pareto reads usage.json identically for both.
 *
 * The judge record is synthesized as a single `type: "usage"` event so
 * the summarizer treats it exactly like any other usage-bearing
 * AgentEvent. `EvalResult.usage` is already shaped (provider/model/
 * input_tokens/output_tokens) by the judge so no further translation
 * happens here.
 */
function buildRunUsageEvents(
  ingestEvents: AgentEvent[],
  questionEvents: AgentEvent[],
  judgeUsage: Record<string, unknown> | undefined,
): AgentEvent[] {
  const events: AgentEvent[] = [...ingestEvents, ...questionEvents];
  if (judgeUsage) {
    events.push({ message: { type: "usage", usage: judgeUsage } });
  }
  return events;
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
  const cliArgv = input.cliArgv;

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
      cliArgv,
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

    // Persist the question-turn events as the run's `assistant-events.json`
    // (what the agent said in response to the question), and the ingest-turn
    // events as `ingest-assistant-events.json` (the agent's memory-formation
    // work consuming the haystack sessions). The report surfaces them as two
    // separate sections so the question-turn view doesn't get diluted.
    await writeFile(
      artifacts.assistantEventsPath,
      JSON.stringify(ingestAskResult.questionEvents, null, 2),
    );
    await writeIngestAssistantEvents(input.runId, ingestAskResult.ingestEvents);

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

    // Roll usage from both conversations + the judge (if it surfaced
    // one) through the shared summarizer. Best-effort: a write failure
    // is logged via the swallowed promise but never blocks the run —
    // the metric + transcript are already on disk.
    const usageEvents = buildRunUsageEvents(
      ingestAskResult.ingestEvents,
      ingestAskResult.questionEvents,
      evalResult.usage,
    );
    await writeUsage(input.runId, summarizeAssistantUsage(usageEvents)).catch(
      () => undefined,
    );

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
    // Persist whatever ingest-turn events were captured before the
    // failure so a run that aborted (e.g. an ingest that never reached
    // its completion sentinel) can still be inspected in the report.
    if (err instanceof IngestAskError && err.ingestEvents.length > 0) {
      await writeIngestAssistantEvents(input.runId, [
        ...err.ingestEvents,
      ]).catch(() => undefined);
    }
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
