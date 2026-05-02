/**
 * Types extracted from scheduler.ts to break the scheduler ↔ engine cycle.
 * `sequence/engine.ts` needs `ScheduleMessageProcessor` but scheduler.ts
 * imports from engine — extracting the type here breaks the back-edge.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";

export interface ScheduleMessageOptions {
  trustClass?: "guardian" | "trusted_contact" | "unknown";
  taskRunId?: string;
  /**
   * Optional LLM call-site identifier propagated to the per-call provider
   * config. Schedule and sequence callers will start passing their own call-site
   * (e.g. for a future scheduled-agent profile) once PRs 7-11 migrate them off
   * the default `mainAgent` route.
   */
  callSite?: LLMCallSite;
}

export type ScheduleMessageProcessor = (
  conversationId: string,
  message: string,
  options?: ScheduleMessageOptions,
) => Promise<unknown>;
