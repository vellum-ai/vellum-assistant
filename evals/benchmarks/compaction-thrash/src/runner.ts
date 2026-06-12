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
 * Approximate number of estimator-tokens each tick message should add to
 * conversation history. Sized so a span of seed ticks reliably carries the
 * conversation across the compaction threshold even though the base context
 * (system prompt + tool catalog, which the daemon's overflow gate includes
 * in its estimate) is large and not precisely known to the benchmark.
 *
 * The daemon estimates ~1 token per 4 characters (`CHARS_PER_TOKEN` in
 * `assistant/src/context/token-estimator.ts`), so a ~2000-token message is
 * ~8000 characters. See `vellum-compaction-stress` profile setup and the
 * arithmetic in `scenarios/cron-noop/SPEC.md` for how this pairs with the
 * shrunken `maxInputTokens` window to produce repeated compaction.
 */
const TICK_TARGET_TOKENS = 2000;
const TICK_TARGET_CHARS = TICK_TARGET_TOKENS * 4;

/**
 * Build a deterministic cron-tick message. Each tick simulates a
 * scheduled polling job checking a Slack channel that produces no
 * actionable results — mimicking the real-world pattern that caused
 * unbounded context growth.
 *
 * The message is padded with deterministic record-keeping filler to
 * ~`TICK_TARGET_TOKENS` estimator-tokens so context grows by a large,
 * predictable amount each tick. This dominates the unknown base-context
 * size so the compaction threshold is reached within the seed phase
 * regardless of how big the assistant's system prompt + tool catalog are.
 * The content stays deterministic (no randomness) so the reproduction is
 * reliable — the only varying tokens are the tick number and an ISO
 * timestamp.
 */
function buildTickMessage(tickNumber: number): string {
  const timestamp = new Date().toISOString();
  const header = [
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
    "",
    "Per-thread audit (all unchanged since last poll):",
  ].join("\n");

  // Deterministic filler: one audit line per monitored thread, repeated
  // until the message reaches the target size. Pure function of the tick
  // number, so two runs produce byte-identical messages.
  const lines: string[] = [];
  let i = 0;
  while (header.length + lines.join("\n").length < TICK_TARGET_CHARS) {
    lines.push(
      `- thread-${i}: status=quiet last_activity=none watchers=0 ` +
        `escalation=none note="no change observed during poll ${tickNumber}"`,
    );
    i++;
  }
  return `${header}\n${lines.join("\n")}`;
}

/** Per-tick observation record written to the scenario artifacts. */
export interface TickObservation {
  tick: number;
  phase: "seed" | "observe";
  eventCount: number;
  /**
   * Number of compaction passes observed this tick. Counted from the
   * `assistant_activity_state` SSE event with `reason: "context_compacting"`
   * (the on-the-wire marker the daemon emits once per proactive compaction
   * pass), collapsing any consecutive same-reason events so one pass counts
   * once. Defensively also counts the internal `context_compacting`
   * AgentEvent type, though that type does not cross the SSE wire today.
   */
  compactionEvents: number;
  /**
   * Total input tokens for this tick. Sourced from the egress jail's
   * recorded usage records when present (the cost/usage authority per
   * `evals/AGENTS.md`); falls back to SSE `usage_update` events otherwise.
   */
  inputTokens: number;
  /** Total output tokens for this tick (same source preference as input). */
  outputTokens: number;
  /**
   * Cache-creation (cache-write) input tokens this tick, from jail
   * records when present, else from the SSE `usage_update` event's
   * optional cache fields (older daemons omit them, leaving this 0 on
   * the SSE path). This is the headline signal for cache-write
   * amplification.
   */
  cacheCreationInputTokens: number;
  /** Cache-read input tokens this tick (same sources as cache-creation). */
  cacheReadInputTokens: number;
  /**
   * Max `contextWindowTokens` seen on `usage_update` SSE events this tick.
   * Diagnostic only: shows the conversation's context growing toward the
   * compaction threshold. `undefined` when no usage_update carried it.
   */
  contextWindowTokens?: number;
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
 * Count proactive-compaction passes from a tick's SSE events.
 *
 * On the wire (NDJSON from `vellum events --json`), a proactive compaction
 * pass surfaces as an `assistant_activity_state` event with
 * `reason: "context_compacting"` — NOT as a top-level `context_compacting`
 * message type (that type only exists inside the daemon's agent loop and is
 * translated to the activity-state event before it leaves the daemon; see
 * `assistant/src/daemon/conversation-agent-loop-handlers.ts` case
 * "context_compacting").
 *
 * The auto-compaction path emits exactly one such activity-state event per
 * pass, so a single pass counts once. We additionally collapse *consecutive*
 * `context_compacting` activity-state events into one pass: if a future
 * daemon change ever emitted the marker more than once back-to-back for the
 * same pass, this still counts one. A new pass is recognized when a
 * non-compacting activity-state (or any non-activity-state-compacting gap)
 * separates two compacting markers — the daemon brackets each pass with
 * other activity states (e.g. "thinking", "message_complete").
 *
 * The internal `context_compacting` / `compaction_completed` message types
 * are also handled (the former counts, the latter is ignored) so the counter
 * stays correct if the wire ever carries them directly.
 */
export function countCompactionPasses(events: AgentEvent[]): number {
  let passes = 0;
  let inCompactingRun = false;
  for (const event of events) {
    const msg = event.message;
    const isActivityCompacting =
      msg.type === "assistant_activity_state" &&
      msg.reason === "context_compacting";
    const isInternalCompacting = msg.type === "context_compacting";

    if (isActivityCompacting || isInternalCompacting) {
      if (!inCompactingRun) {
        passes++;
        inCompactingRun = true;
      }
      continue;
    }
    // `compaction_completed` is the paired end of an internal pass; treat it
    // (and any other event) as the boundary that closes the current run so a
    // later compacting marker is counted as a fresh pass.
    inCompactingRun = false;
  }
  return passes;
}

/**
 * Observe per-tick metrics for a single tick.
 *
 * Compaction passes are counted from SSE events (see
 * {@link countCompactionPasses}).
 *
 * Token usage is sourced with a strict preference order, per
 * `evals/AGENTS.md` ("Assistant-side usage must come from
 * `readUsageRecords()` — never from emitted events"):
 *
 * 1. **Egress jail records** (`jailRecords`) — the cost/usage authority.
 *    Flat snake_case Anthropic-usage records (`input_tokens`,
 *    `output_tokens`, `cache_creation_input_tokens`,
 *    `cache_read_input_tokens`). These carry the cache fields that the
 *    benchmark exists to measure; the SSE wire does not. When any jail
 *    records exist for the tick, they are the sole source of token counts.
 * 2. **SSE `usage_update` fallback** — used only when no jail records
 *    exist (e.g. a non-vellum species whose adapter has no jail). Fields
 *    live directly on `event.message` (camelCase); there are no cache
 *    fields, so cache-write/read stay zero on this path.
 *
 * `contextWindowTokens` (a diagnostic showing context growth toward the
 * threshold) is always read from `usage_update` SSE events — the jail does
 * not carry it — and reports the max seen this tick.
 */
export function observeTick(
  tickNumber: number,
  phase: "seed" | "observe",
  events: AgentEvent[],
  jailRecords: Array<Record<string, unknown>>,
): TickObservation {
  const compactionEvents = countCompactionPasses(events);

  // Diagnostic: max context-window size reported by usage_update this tick.
  let contextWindowTokens: number | undefined;
  for (const event of events) {
    const msg = event.message;
    if (msg.type !== "usage_update") continue;
    const cw = msg["contextWindowTokens"];
    if (typeof cw === "number" && Number.isFinite(cw)) {
      contextWindowTokens = Math.max(contextWindowTokens ?? 0, cw);
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  if (jailRecords.length > 0) {
    // Preferred path: jail-recorded usage is the authority and the only
    // source of cache fields.
    for (const record of jailRecords) {
      const fields = extractUsageFields(record);
      inputTokens += fields.inputTokens;
      outputTokens += fields.outputTokens;
      cacheCreationInputTokens += fields.cacheCreationInputTokens;
      cacheReadInputTokens += fields.cacheReadInputTokens;
    }
  } else {
    // Fallback: SSE usage_update events (no cache fields on the wire).
    for (const event of events) {
      const msg = event.message;
      if (msg.type === "usage_update") {
        const fields = extractUsageFields(msg as Record<string, unknown>);
        inputTokens += fields.inputTokens;
        outputTokens += fields.outputTokens;
        cacheCreationInputTokens += fields.cacheCreationInputTokens;
        cacheReadInputTokens += fields.cacheReadInputTokens;
        continue;
      }
      const usage = msg.usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const fields = extractUsageFields(usage as Record<string, unknown>);
        inputTokens += fields.inputTokens;
        outputTokens += fields.outputTokens;
        cacheCreationInputTokens += fields.cacheCreationInputTokens;
        cacheReadInputTokens += fields.cacheReadInputTokens;
      }
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
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
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
 * Compute metrics from observed tick data. All token inputs come from the
 * per-tick usage source `observeTick` chose (egress-jail records when
 * present, else SSE `usage_update`); cache-derived metrics are only
 * meaningful when jail records were available, since the SSE wire carries
 * no cache fields.
 *
 * - `compaction-efficiency`: fraction of total cache tokens that were
 *   cache-read (vs cache-write) during the observation phase. Higher
 *   is better — means the prompt cache stays warm.
 * - `cache-write-ratio`: fraction of observation-phase input tokens
 *   spent on cache creation. Lower is better.
 * - `compaction-pass-count`: total proactive-compaction passes
 *   (one per `assistant_activity_state` `context_compacting` marker)
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
      reason: `${totalCompactionPasses} compaction passes across ${observePhase.length} observation ticks`,
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

    // The egress jail accumulates one cumulative NDJSON record per upstream
    // LLM call. We snapshot the cumulative count after each tick and slice
    // out the records that landed during the tick, so per-tick token/cache
    // usage comes from the cost/usage authority (`evals/AGENTS.md`) rather
    // than from SSE events (which carry no cache fields). When the adapter
    // has no jail (`readUsageRecords` absent), the slice is always empty and
    // `observeTick` falls back to SSE `usage_update`.
    let prevRecordCount = 0;

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

      // Slice the jail records that landed during this tick. Reading the
      // full cumulative list and slicing (rather than diffing token sums)
      // keeps the authority single-sourced and tolerant of records that
      // arrive slightly out of order within a tick.
      const cumulativeRecords = (await agent.readUsageRecords?.()) ?? [];
      const tickRecords = cumulativeRecords.slice(prevRecordCount);
      prevRecordCount = cumulativeRecords.length;

      const observation = observeTick(tick, phase, events, tickRecords);
      observations.push(observation);

      progress({
        step: "events",
        status: "done",
        message: `[${phase}] Tick ${tick}: ${events.length} events, ${observation.compactionEvents} compaction, cache_write=${observation.cacheCreationInputTokens} cache_read=${observation.cacheReadInputTokens}, ctx=${observation.contextWindowTokens ?? "?"}`,
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

    // Dump the agent's own usage ledger (per-call-site attribution with
    // cache splits) as a diagnostic artifact. This is the daemon-side
    // ground truth for "how much of the spend was compaction" —
    // independent of both the SSE event stream and the egress jail.
    const usageLedger = (await agent.readUsageLedger?.()) ?? null;
    if (usageLedger !== null) {
      await writeFile(
        `${artifactDir}/usage-ledger.json`,
        JSON.stringify(usageLedger, null, 2),
      );
      progress({
        step: "metrics",
        status: "start",
        message: "Usage ledger captured (per-call-site attribution)",
        detail: `${artifactDir}/usage-ledger.json`,
      });
    }

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
