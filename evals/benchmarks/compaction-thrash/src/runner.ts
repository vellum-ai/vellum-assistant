/**
 * Per-scenario runner for the compaction-thrash benchmark.
 *
 * Hatches a Vellum assistant, seeds a conversation with enough
 * simulated cron-tick messages to approach the compaction threshold,
 * then continues sending ticks to observe compaction behavior:
 * how often it fires, how much context it frees, and whether
 * cache-write amplification occurs from non-deterministic summary
 * rewording.
 *
 * Each tick sends a fixed no-op polling message (deterministic content
 * so the reproduction is reliable and not dependent on simulator
 * non-determinism).
 */
import { writeFile } from "node:fs/promises";

import type { AgentEvent } from "../../../src/lib/adapter.js";
import {
  type EvalRunResult,
  markErrorAsReportedToProgress,
} from "../../../src/lib/runner/run-once.js";
import type { EvalProgressReporter } from "../../../src/lib/runner/progress.js";
import { createRunProgressLifecycle } from "../../../src/lib/runner/progress-lifecycle.js";
import {
  appendAssistantEvents,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  type MetricResult,
  updateRunMetadata,
  writeMetricResults,
  writeRunMetadata,
  writeUsage,
} from "../../../src/lib/metrics.js";
import type { Profile } from "../../../src/lib/profile.js";
import type { TranscriptTurn } from "../../../src/lib/transcript.js";
import {
  mergeUsageSummaries,
  summarizeAssistantUsage,
} from "../../../src/lib/usage.js";
import { createAgent } from "../../../src/lib/runner/create-agent.js";
import { AgentEventCollector } from "../../../src/lib/runner/event-collector.js";

/** Quiet timeout for event draining after each tick message. */
const TICK_QUIET_MS = 30_000;
/** Hard wall-clock cap per tick. */
const TICK_MAX_MS = 5 * 60_000;

/**
 * Number of seed ticks to send before entering the observation phase.
 * Configurable via `EVALS_COMPACTION_SEED_TICKS`.
 */
const DEFAULT_SEED_TICKS = 20;

/**
 * Number of post-threshold observation ticks.
 * Configurable via `EVALS_COMPACTION_OBSERVE_TICKS`.
 */
const DEFAULT_OBSERVE_TICKS = 10;

/**
 * Build a deterministic cron-tick message. Each tick simulates a
 * scheduled polling job checking a Slack channel that produces no
 * actionable results — mimicking the real-world pattern that caused
 * unbounded context growth.
 *
 * The message is deliberately verbose (~500 tokens) so context grows
 * meaningfully with each tick, reaching the compaction threshold in
 * a reasonable number of iterations.
 */
function buildTickMessage(tickNumber: number): string {
  const timestamp = new Date().toISOString();
  return [
    `Schedule fired: check-project-updates (tick #${tickNumber})`,
    `Timestamp: ${timestamp}`,
    "",
    "Checking #project-updates for new messages since last poll...",
    "",
    "Poll results:",
    "- Channel: #project-updates",
    "- Messages found: 0",
    "- Threads updated: 0",
    "- Reactions: none",
    "- Files shared: none",
    "",
    "No new activity detected. The channel has been quiet since the",
    "last check. All monitored threads remain in their previous state.",
    "",
    "Automated monitoring summary:",
    `- This is poll iteration #${tickNumber}`,
    "- No alerts triggered",
    "- No escalation criteria met",
    "- Channel health: nominal",
    "- Next scheduled check: 15 minutes",
    "",
    "Please remember this check result for future reference and note",
    "that the channel remains inactive. If this pattern continues,",
    "consider whether the monitoring schedule should be adjusted.",
    "",
    "Additional context for record-keeping:",
    `- Monitor started: session initialization`,
    `- Total polls completed: ${tickNumber}`,
    "- Consecutive quiet polls: " + tickNumber,
    "- Monitoring category: low-priority",
    "- SLA status: within bounds",
  ].join("\n");
}

/** Per-tick observation record written to the scenario artifacts. */
export interface TickObservation {
  tick: number;
  phase: "seed" | "observe";
  eventCount: number;
  /** Number of usage events that mention compaction-related call sites. */
  compactionEvents: number;
  /** Total input tokens across all usage events for this tick. */
  inputTokens: number;
  /** Total output tokens across all usage events for this tick. */
  outputTokens: number;
  /** Cache-creation input tokens observed this tick. */
  cacheCreationInputTokens: number;
  /** Cache-read input tokens observed this tick. */
  cacheReadInputTokens: number;
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * Extract token fields from a usage record. Handles both camelCase
 * (daemon SSE `usage_update` events, where fields live directly on
 * `event.message`) and snake_case (egress-proxy recorded usage).
 */
function extractUsageFields(record: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  return {
    inputTokens: num(record["input_tokens"] ?? record["inputTokens"]),
    outputTokens: num(record["output_tokens"] ?? record["outputTokens"]),
    cacheCreationInputTokens: num(
      record["cache_creation_input_tokens"] ??
        record["cacheCreationInputTokens"],
    ),
    cacheReadInputTokens: num(
      record["cache_read_input_tokens"] ?? record["cacheReadInputTokens"],
    ),
  };
}

/**
 * Observe per-tick metrics from agent events.
 *
 * Usage data arrives in two shapes depending on the source:
 * 1. **Daemon SSE (`usage_update`):** fields live directly on
 *    `event.message` (camelCase: `inputTokens`, `outputTokens`, …).
 * 2. **Egress-proxy recorded usage (wrapped):** a nested
 *    `event.message.usage` object (snake_case or camelCase).
 *
 * Compaction is detected via `context_compacting` events emitted by
 * the agent loop when compaction starts — not inferred from usage
 * call sites (which aren't on the SSE wire).
 */
function observeTick(
  tickNumber: number,
  phase: "seed" | "observe",
  events: AgentEvent[],
): TickObservation {
  let compactionEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  for (const event of events) {
    const msg = event.message;

    // Count each compaction pass once via the start event.
    // `context_compacting` fires when the pipeline begins;
    // `compaction_completed` is the paired end event.
    if (msg.type === "context_compacting") {
      compactionEvents++;
      continue;
    }
    if (msg.type === "compaction_completed") continue;

    // Path 1: daemon SSE `usage_update` — fields on msg directly
    if (msg.type === "usage_update") {
      const fields = extractUsageFields(msg as Record<string, unknown>);
      inputTokens += fields.inputTokens;
      outputTokens += fields.outputTokens;
      cacheCreationInputTokens += fields.cacheCreationInputTokens;
      cacheReadInputTokens += fields.cacheReadInputTokens;
      continue;
    }

    // Path 2: wrapped usage (egress-proxy records or synthetic events)
    const usage = msg.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const fields = extractUsageFields(usage as Record<string, unknown>);
      inputTokens += fields.inputTokens;
      outputTokens += fields.outputTokens;
      cacheCreationInputTokens += fields.cacheCreationInputTokens;
      cacheReadInputTokens += fields.cacheReadInputTokens;
    }
  }

  return {
    tick: tickNumber,
    phase,
    eventCount: events.length,
    compactionEvents,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

export interface RunCompactionThrashInput {
  profile: Profile;
  scenarioId: string;
  runId: string;
  sessionId?: string;
  sessionLabel?: string;
  cliArgv?: string[];
  progress?: EvalProgressReporter;
  seedTicks?: number;
  observeTicks?: number;
}

/**
 * Compute metrics from observed tick data.
 *
 * - `compaction-efficiency`: fraction of total input tokens that were
 *   cache-read (vs cache-write) during the observation phase. Higher
 *   is better — means the prompt cache stays warm.
 * - `cache-write-ratio`: fraction of observation-phase input tokens
 *   spent on cache creation. Lower is better.
 * - `compaction-pass-count`: total compaction-related usage events
 *   during the observation phase. Lower is better.
 * - `cost-per-tick`: average total input+output tokens per observation
 *   tick (raw count, not USD — pricing depends on model).
 */
function computeMetrics(observations: TickObservation[]): MetricResult[] {
  const observePhase = observations.filter((o) => o.phase === "observe");
  if (observePhase.length === 0) {
    return [
      {
        name: "compaction-efficiency",
        score: 0,
        reason: "No observation ticks completed",
        unit: "fraction",
      },
      {
        name: "cache-write-ratio",
        score: 1,
        reason: "No observation ticks completed",
        unit: "fraction",
      },
      {
        name: "compaction-pass-count",
        score: 0,
        reason: "No observation ticks completed",
        unit: "raw",
      },
      {
        name: "cost-per-tick",
        score: 0,
        reason: "No observation ticks completed",
        unit: "raw",
      },
    ];
  }

  const totalCacheWrite = observePhase.reduce(
    (sum, o) => sum + o.cacheCreationInputTokens,
    0,
  );
  const totalCacheRead = observePhase.reduce(
    (sum, o) => sum + o.cacheReadInputTokens,
    0,
  );
  const totalInput = observePhase.reduce((sum, o) => sum + o.inputTokens, 0);
  const totalOutput = observePhase.reduce((sum, o) => sum + o.outputTokens, 0);
  const totalCompactionPasses = observePhase.reduce(
    (sum, o) => sum + o.compactionEvents,
    0,
  );

  const totalCacheTokens = totalCacheWrite + totalCacheRead;
  const cacheEfficiency =
    totalCacheTokens > 0 ? totalCacheRead / totalCacheTokens : 0;
  const cacheWriteRatio = totalInput > 0 ? totalCacheWrite / totalInput : 1;
  const avgTokensPerTick = (totalInput + totalOutput) / observePhase.length;

  return [
    {
      name: "compaction-efficiency",
      score: cacheEfficiency,
      reason: `Cache read ${totalCacheRead} / total cache ${totalCacheTokens} tokens`,
      unit: "fraction",
      metadata: { totalCacheRead, totalCacheWrite, totalCacheTokens },
    },
    {
      name: "cache-write-ratio",
      score: cacheWriteRatio,
      reason: `Cache creation ${totalCacheWrite} / total input ${totalInput} tokens`,
      unit: "fraction",
      metadata: { totalCacheWrite, totalInput },
    },
    {
      name: "compaction-pass-count",
      score: totalCompactionPasses,
      reason: `${totalCompactionPasses} compaction events across ${observePhase.length} observation ticks`,
      unit: "raw",
      metadata: {
        totalCompactionPasses,
        observeTicks: observePhase.length,
        perTick: observePhase.map((o) => o.compactionEvents),
      },
    },
    {
      name: "cost-per-tick",
      score: avgTokensPerTick,
      reason: `Avg ${Math.round(avgTokensPerTick)} tokens/tick over ${observePhase.length} observation ticks`,
      unit: "raw",
      metadata: { totalInput, totalOutput, observeTicks: observePhase.length },
    },
  ];
}

export async function runCompactionThrashScenario(
  input: RunCompactionThrashInput,
): Promise<EvalRunResult> {
  const sessionId = input.sessionId ?? input.runId;
  const sessionLabel = input.sessionLabel;
  const cliArgv = input.cliArgv;
  const seedTicks = input.seedTicks ?? DEFAULT_SEED_TICKS;
  const observeTickCount = input.observeTicks ?? DEFAULT_OBSERVE_TICKS;
  const totalTicks = seedTicks + observeTickCount;

  const { progress, dispose } = createRunProgressLifecycle({
    runId: input.runId,
    userProgress: input.progress,
  });

  const startedAt = new Date().toISOString();
  let artifactDir = "";

  const agent = createAgent({
    profile: input.profile,
    testId: input.scenarioId,
    runId: input.runId,
  });

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
      testId: input.scenarioId,
      status: "running",
      startedAt,
      artifactDir,
    });

    progress({
      step: "hatch",
      status: "start",
      message: "Hatching assistant",
      detail: input.profile.id,
    });
    await agent.hatch();
    progress({
      step: "hatch",
      status: "done",
      message: "Assistant ready",
      detail: agent.id,
    });

    progress({
      step: "events",
      status: "start",
      message: "Subscribing to assistant events",
      detail: agent.conversationKey,
    });
    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );
    progress({
      step: "events",
      status: "done",
      message: "Assistant event stream connected",
      detail: agent.conversationKey,
    });

    const allEvents: AgentEvent[] = [];
    const observations: TickObservation[] = [];
    const transcript: TranscriptTurn[] = [];

    for (let tick = 1; tick <= totalTicks; tick++) {
      const phase: "seed" | "observe" = tick <= seedTicks ? "seed" : "observe";
      const message = buildTickMessage(tick);

      progress({
        step: "send",
        status: "start",
        message: `[${phase}] Sending tick ${tick}/${totalTicks}`,
        turn: tick,
      });

      await appendSimulatorMessage(input.runId, { content: message });
      const turnTimestamp = new Date().toISOString();
      transcript.push({
        role: "simulator",
        content: message,
        emittedAt: turnTimestamp,
      });
      await appendTranscriptTurn(input.runId, {
        role: "simulator",
        content: message,
        emittedAt: turnTimestamp,
      });
      await agent.send({ content: message });

      progress({
        step: "send",
        status: "done",
        message: `[${phase}] Tick ${tick} sent`,
        turn: tick,
      });

      progress({
        step: "events",
        status: "start",
        message: `[${phase}] Waiting for assistant response (tick ${tick})`,
        turn: tick,
      });

      const events = await collector.collectUntilQuiet({
        quietMs: TICK_QUIET_MS,
        maxMs: TICK_MAX_MS,
      });
      allEvents.push(...events);
      await appendAssistantEvents(input.runId, events);

      for (const event of events) {
        const text = event.message.text ?? event.message.chunk;
        if (text?.trim()) {
          const eventTimestamp = event.emittedAt ?? new Date().toISOString();
          transcript.push({
            role: "assistant",
            content: text.trim(),
            emittedAt: eventTimestamp,
          });
          await appendTranscriptTurn(input.runId, {
            role: "assistant",
            content: text.trim(),
            emittedAt: eventTimestamp,
          });
        }
      }

      const observation = observeTick(tick, phase, events);
      observations.push(observation);

      progress({
        step: "events",
        status: "done",
        message: `[${phase}] Tick ${tick}: ${events.length} events, ${observation.compactionEvents} compaction, cache_write=${observation.cacheCreationInputTokens} cache_read=${observation.cacheReadInputTokens}`,
        turn: tick,
      });

      // Write usage after every tick so partial runs are inspectable.
      await writeUsage(input.runId, summarizeAssistantUsage(allEvents));
    }

    // Merge in egress-jail recorded usage for accurate cost accounting.
    const recordedUsage = (await agent.readUsageRecords?.()) ?? [];
    if (recordedUsage.length > 0) {
      const recordedEvents: AgentEvent[] = recordedUsage.map((usage) => ({
        message: { type: "usage", usage },
      }));
      const recordedSummary = summarizeAssistantUsage(recordedEvents);
      const eventSummary = summarizeAssistantUsage(allEvents);
      await writeUsage(
        input.runId,
        mergeUsageSummaries(eventSummary, recordedSummary),
      );
    }

    // Write tick-level observations as a benchmark-specific artifact.
    await writeFile(
      `${artifactDir}/tick-observations.json`,
      JSON.stringify(observations, null, 2),
    );

    // Compute and persist metrics.
    const metrics = computeMetrics(observations);
    await writeMetricResults(input.runId, metrics);

    const metricSummary = metrics
      .map((m) =>
        m.unit === "raw"
          ? `${m.name}=${m.score}`
          : `${m.name}=${(m.score * 100).toFixed(1)}%`,
      )
      .join(", ");

    progress({
      step: "metrics",
      status: "done",
      message: `Metrics: ${metricSummary}`,
      detail: input.scenarioId,
    });

    progress({
      step: "result",
      status: "done",
      message: `Run completed: ${metricSummary}`,
      detail: input.scenarioId,
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
      testId: input.scenarioId,
      artifactDir,
      transcript,
      metrics,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress({
      step: "shutdown",
      status: "error",
      message,
    });
    markErrorAsReportedToProgress(err);
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
    try {
      await agent.shutdown();
    } catch {
      // Best-effort teardown.
    }
  }
}
