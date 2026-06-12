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
  appendAssistantEvents,
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
  DEFAULT_QUESTION_MAX_MS,
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
   * Quiet timeout (ms) for the *question* turn's event drain in
   * `runIngestAsk`. Defaults to 30s — same default the underlying
   * runner uses, surfaced here so the harness can override per-run.
   */
  quietMs?: number;
  /**
   * Hard wall-clock cap (ms) for the *question* turn in `runIngestAsk`.
   * Defaults to 6 minutes. If the agent doesn't produce an answer within
   * this budget the run is graded as a completed miss (score 0), not an
   * errored run. Surfaced here so the harness can override per-run.
   */
  questionMaxMs?: number;
  /**
   * Quiet timeout (ms) for the *ingest* turn's event drain in
   * `runIngestAsk`. Defaults to 2 minutes — the ingest turn is a heavy
   * multi-step turn whose between-step silences are far longer than a
   * question turn's, so it needs a more generous safety net (the
   * completion sentinel, not silence, decides when it's done). Surfaced
   * here so the harness can override per-run.
   */
  ingestQuietMs?: number;
  /** Caller-side overrides applied after the per-question spec kwargs. */
  judgeOverrides?: EvalOverrides;
}

/**
 * Compose the conversation-A "ingest" prompt. Deliberately
 * question-blind — it points at the staged files and asks the agent to
 * save a single durable memory note recording that the dataset exists,
 * where it lives, and that later questions are answered by consulting
 * the files on demand. It does not ask the agent to read or memorize the
 * trajectories up front, and it does not reveal the question text; the
 * question turn is a fresh conversation B.
 *
 * The "save a pointer to memory, then reply Ready." contract is portable:
 * for any species whose memory write is synchronous within the turn, the
 * note persists into conversation B with no out-of-band "await memory"
 * step, and the staged workspace files remain available there for
 * on-demand retrieval. Memory-less baselines have nothing to save and
 * still answer.
 */
function buildIngestMessage(trajectoryCount: number): string {
  return [
    `I have staged ${trajectoryCount} trajectory file(s) into your workspace at`,
    `\`${WORKSPACE_TRAJECTORY_DIR}/\` (one JSON file per trajectory, named`,
    `\`<trajectory_id>.json\`).`,
    `An index of the files in haystack order lives at \`${WORKSPACE_MANIFEST_PATH}\`.`,
    "",
    "These files stay in your workspace. You do NOT need to read or memorize",
    "them now. I will ask follow-up questions in a brand-new conversation that",
    "will NOT share this chat history — so the one thing that must survive is a",
    "memory that this dataset exists and how to use it.",
    "",
    "Using your memory tools, save a short, durable note recording: that this",
    "dataset of web-agent / ServiceNow task trajectories exists, that it lives",
    `at \`${WORKSPACE_TRAJECTORY_DIR}/\` indexed by \`${WORKSPACE_MANIFEST_PATH}\`,`,
    "and that to answer later questions you should consult these files on",
    "demand — reading the specific trajectories relevant to each question",
    "rather than all of them.",
    "",
    "When — and only when — that note is saved to memory, reply with a single",
    'line: "Ready."',
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
 * Roll the run's usage into the same `usage.json` shape `runEvalOnce`
 * writes, then fold it through the shared `summarizeAssistantUsage` so token
 * sums, cost pricing, and cost diagnostics stay consistent across both runner
 * shapes — Phase 2's cost/latency Pareto reads usage.json identically for
 * both.
 *
 * Two usage sources, deliberately separated by trust:
 *
 * - **Assistant usage** comes from `recordedUsage` — token counts the egress
 *   jail's recording sidecar parsed out of the assistant's *observed* model
 *   traffic. It is NOT derived from `ingestEvents`/`questionEvents`: an
 *   assistant (or its adapter) can choose what events to emit, so pricing
 *   emitted events would let a species under-report its own cost. The jail
 *   sees the real provider responses, so it is the un-spoofable authority.
 * - **Judge usage** is the harness's *own* grading call (`EvalResult.usage`,
 *   already shaped provider/model/input_tokens/output_tokens). It is not
 *   assistant-emitted, so synthesizing it as a `type: "usage"` event is fine.
 *
 * Each record is wrapped as a single `type: "usage"` event so the summarizer
 * treats it exactly like any other usage-bearing AgentEvent.
 */
function buildRunUsageEvents(
  recordedUsage: Array<Record<string, unknown>>,
  judgeUsage: Record<string, unknown> | undefined,
): AgentEvent[] {
  const events: AgentEvent[] = recordedUsage.map((usage) => ({
    message: { type: "usage", usage },
  }));
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
  const questionMaxMs = input.questionMaxMs ?? DEFAULT_QUESTION_MAX_MS;

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
      profileManifest: input.profile.manifest,
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
      questionMaxMs,
      ingestQuietMs: input.ingestQuietMs,
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

    let metric: MetricResult;
    let judgeUsage: Record<string, unknown> | undefined;
    if (!ingestAskResult.questionAnswered) {
      // The agent produced no answer within the question turn's time budget
      // (it ran to the `questionMaxMs` wall-clock cap, or went quiet, mid-
      // work). Grade it as a completed miss — score 0 — rather than erroring
      // the run. "Too slow to answer" is a real outcome that belongs in the
      // score and the denominator, not an excluded `failed` run. No judge
      // call is made: there's nothing to grade.
      const budgetSeconds = Math.round(questionMaxMs / 1000);
      metric = {
        name: "longmemeval-v2-judge",
        score: 0,
        reason: `No answer produced within the question turn's ${budgetSeconds}s time budget.`,
        metadata: {
          function: "no-answer",
          ability: input.item.ability,
          questionId: input.item.questionId,
        },
      };
      judgeUsage = undefined;
    } else {
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
      metric = metricFromEvalResult(evalResult, input.item);
      judgeUsage = evalResult.usage;
    }
    await writeFile(artifacts.metricsPath, JSON.stringify([metric], null, 2));

    // Roll the egress jail's observed assistant usage + the judge's own
    // usage (if it surfaced one) through the shared summarizer. Best-effort:
    // a write failure is logged via the swallowed promise but never blocks
    // the run — the metric + transcript are already on disk.
    const usageEvents = buildRunUsageEvents(
      ingestAskResult.recordedUsage,
      judgeUsage,
    );
    await writeUsage(input.runId, summarizeAssistantUsage(usageEvents)).catch(
      () => undefined,
    );

    progress({
      step: "metrics",
      status: "done",
      message: `Run metric ${metric.name}=${metric.score.toFixed(2)}`,
      detail: input.item.questionId,
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
    // Persist whatever events were captured before the failure so a run
    // that aborted can still be inspected in the report: ingest-turn
    // events (e.g. an ingest that never reached its completion sentinel)
    // and question-turn events (e.g. conversation B emitted zero events).
    // A question turn that ran its full time budget without composing an
    // answer is NOT a failure — it returns and is graded as a completed
    // miss above, so it never reaches this catch.
    if (err instanceof IngestAskError) {
      if (err.ingestEvents.length > 0) {
        await writeIngestAssistantEvents(input.runId, [
          ...err.ingestEvents,
        ]).catch(() => undefined);
      }
      if (err.questionEvents.length > 0) {
        await appendAssistantEvents(input.runId, [...err.questionEvents]).catch(
          () => undefined,
        );
      }
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
