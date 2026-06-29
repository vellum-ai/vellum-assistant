/**
 * Types extracted from scheduler.ts to break the scheduler ↔ engine cycle.
 * `sequence/engine.ts` needs `ScheduleMessageProcessor` but scheduler.ts
 * imports from engine — extracting the type here breaks the back-edge.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";

export interface ScheduleMessageOptions {
  trustClass?:
    | "guardian"
    | "trusted_contact"
    | "unverified_contact"
    | "unknown";
  taskRunId?: string;
  /**
   * Optional LLM call-site identifier propagated to the per-call provider
   * config. Schedule and sequence callers will start passing their own call-site
   * (e.g. for a future scheduled-agent profile) once PRs 7-11 migrate them off
   * the default `mainAgent` route.
   */
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc inference-profile override (`llm.profiles` key) applied
   * to every LLM call the run issues — a schedule's pinned profile. Omitted
   * = the call site's default resolution (main-agent model selection).
   */
  overrideProfile?: string;
  /**
   * Firing's `cron_runs.id`, stamped onto the turn's usage rows so a scheduled
   * execute turn attributes its LLM spend to that firing. Per-turn: a reused
   * conversation attributes each turn to its own firing.
   */
  cronRunId?: string | null;
}

export type ScheduleMessageProcessor = (
  conversationId: string,
  message: string,
  options?: ScheduleMessageOptions,
) => Promise<unknown>;
