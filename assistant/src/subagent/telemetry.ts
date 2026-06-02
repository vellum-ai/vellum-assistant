/**
 * Per-phase telemetry for subagent builds.
 *
 * Instruments the subagent lifecycle so the tiered app-builder flow's savings
 * (which tier/profile each phase ran on) and failure rates are measurable.
 *
 * This deliberately reuses the two telemetry surfaces already established in
 * the daemon rather than inventing a parallel system:
 *
 *  1. {@link recordLifecycleEvent} — the DB-backed, flush-to-platform sink used
 *     by tool-permission telemetry (`events/tool-permission-telemetry-listener.ts`).
 *     Lifecycle events only carry a string `eventName`, so we encode the
 *     coarse, queryable dimensions (phase / role / tier / outcome) into a
 *     stable, colon-delimited name. This is what makes cross-build aggregation
 *     (tiering savings, failure rates) possible from the platform side.
 *  2. The structured {@link getLogger} pino logger already used throughout
 *     `manager.ts`. The full structured payload (ids, duration, tokens, etc.)
 *     rides on the log record where local/aggregated log tooling can read it —
 *     lifecycle rows are intentionally low-cardinality.
 */

import { recordLifecycleEvent } from "../memory/lifecycle-events-store.js";
import { getLogger } from "../util/logger.js";
import type { SubagentRole } from "./types.js";

const log = getLogger("subagent-telemetry");

/** Lifecycle event-name prefix for every subagent build-phase event. */
const EVENT_PREFIX = "subagent_build";

/** Terminal outcome of a subagent run, as seen by the telemetry layer. */
export type SubagentBuildOutcome = "completed" | "failed" | "aborted";

/**
 * Map a subagent role to its app-builder build *phase* so plan / worker /
 * repair phases are distinguishable in aggregate. Roles that don't map to a
 * build phase fall through to the role name itself, keeping the event useful
 * for non-app-builder subagents too.
 *
 *  - planner  → plan
 *  - coder    → worker
 *  - general  → general (e.g. forks / ad-hoc delegation)
 */
function phaseForRole(role: SubagentRole): string {
  switch (role) {
    case "planner":
      return "plan";
    case "coder":
      return "worker";
    default:
      return role;
  }
}

/** Sanitize a free-form label into a low-cardinality, name-safe token. */
function safeProfileTag(overrideProfile: string | undefined): string {
  if (!overrideProfile) return "default";
  // Lifecycle event names are colon-delimited; keep the segment well-formed.
  return overrideProfile.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface SubagentSpawnTelemetry {
  subagentId: string;
  label: string;
  role: SubagentRole;
  /** The ad-hoc inference-profile override — i.e. the *tier* the phase runs on. */
  overrideProfile?: string;
  isFork: boolean;
}

export interface SubagentTerminalTelemetry extends SubagentSpawnTelemetry {
  outcome: SubagentBuildOutcome;
  /** Wall-clock duration from run start to terminal, when start was recorded. */
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  /** Failure message, when the outcome is `failed`. */
  error?: string;
}

/** Structured spawn event — the payload that rides the structured logger. */
export interface SubagentSpawnEvent {
  event: "subagent_build_spawned";
  subagentId: string;
  label: string;
  role: SubagentRole;
  /** App-builder build phase derived from the role (plan / worker / …). */
  phase: string;
  /** The tier the phase runs on (overrideProfile), or null for the default. */
  overrideProfile: string | null;
  isFork: boolean;
  /** Stable, low-cardinality lifecycle event name for platform aggregation. */
  lifecycleEventName: string;
}

/** Structured terminal event — the payload that rides the structured logger. */
export interface SubagentTerminalEvent {
  event: "subagent_build_terminal";
  subagentId: string;
  label: string;
  role: SubagentRole;
  phase: string;
  overrideProfile: string | null;
  isFork: boolean;
  outcome: SubagentBuildOutcome;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  /**
   * Silent-context-starvation signal: a `coder` (worker) that *completes*
   * having produced zero output tokens — the closest observable proxy, at this
   * layer, for "reported success but did nothing useful". See note below.
   */
  suspiciousZeroOutput: boolean;
  error?: string;
  /** Stable lifecycle event name for the outcome (platform aggregation). */
  lifecycleEventName: string;
  /** Extra lifecycle name emitted when {@link suspiciousZeroOutput} is set. */
  zeroOutputLifecycleEventName?: string;
}

/** Pure builder for the spawn event — no side effects, for unit testing. */
export function buildSubagentSpawnEvent(
  info: SubagentSpawnTelemetry,
): SubagentSpawnEvent {
  const phase = phaseForRole(info.role);
  const tier = safeProfileTag(info.overrideProfile);
  return {
    event: "subagent_build_spawned",
    subagentId: info.subagentId,
    label: info.label,
    role: info.role,
    phase,
    overrideProfile: info.overrideProfile ?? null,
    isFork: info.isFork,
    lifecycleEventName: `${EVENT_PREFIX}:${phase}:${tier}:spawned`,
  };
}

/**
 * Pure builder for the terminal event — no side effects, for unit testing.
 *
 * Silent-context-starvation signal: the manager does not have access to a
 * per-subagent file-write count (the Conversation does not expose one), so we
 * cannot assert "zero file writes" directly. We approximate with zero output
 * tokens on a completed `coder` and surface a dedicated flag/lifecycle name for
 * follow-up rather than over-reaching.
 */
export function buildSubagentTerminalEvent(
  info: SubagentTerminalTelemetry,
): SubagentTerminalEvent {
  const phase = phaseForRole(info.role);
  const tier = safeProfileTag(info.overrideProfile);
  const suspiciousZeroOutput =
    info.outcome === "completed" &&
    info.role === "coder" &&
    info.outputTokens === 0;
  return {
    event: "subagent_build_terminal",
    subagentId: info.subagentId,
    label: info.label,
    role: info.role,
    phase,
    overrideProfile: info.overrideProfile ?? null,
    isFork: info.isFork,
    outcome: info.outcome,
    durationMs: info.durationMs ?? null,
    inputTokens: info.inputTokens,
    outputTokens: info.outputTokens,
    estimatedCost: info.estimatedCost,
    suspiciousZeroOutput,
    ...(info.error ? { error: info.error } : {}),
    lifecycleEventName: `${EVENT_PREFIX}:${phase}:${tier}:${info.outcome}`,
    ...(suspiciousZeroOutput
      ? {
          zeroOutputLifecycleEventName: `${EVENT_PREFIX}:${phase}:${tier}:zero_output`,
        }
      : {}),
  };
}

/**
 * Emit telemetry when a subagent's run is kicked off. The lifecycle event keys
 * on phase + tier so spawn volume per tier is queryable; full detail rides the
 * structured log.
 */
export function emitSubagentSpawnTelemetry(info: SubagentSpawnTelemetry): void {
  try {
    const evt = buildSubagentSpawnEvent(info);
    recordLifecycleEvent(evt.lifecycleEventName);
    log.info(evt, "Subagent build phase spawned");
  } catch (err) {
    // Telemetry must never break the spawn path.
    log.warn({ err }, "Failed to emit subagent spawn telemetry");
  }
}

/**
 * Emit telemetry when a subagent reaches a terminal state, carrying the tier,
 * timing, token usage, and outcome so tiering savings and failure rates are
 * measurable.
 */
export function emitSubagentTerminalTelemetry(
  info: SubagentTerminalTelemetry,
): void {
  try {
    const evt = buildSubagentTerminalEvent(info);
    recordLifecycleEvent(evt.lifecycleEventName);
    if (evt.zeroOutputLifecycleEventName) {
      recordLifecycleEvent(evt.zeroOutputLifecycleEventName);
    }
    log.info(evt, "Subagent build phase terminal");
  } catch (err) {
    // Telemetry must never break the run path.
    log.warn({ err }, "Failed to emit subagent terminal telemetry");
  }
}
