/**
 * A2A v1.0 protocol constants.
 */

import type { TaskState } from "./protocol-types.js";

export const A2A_VERSION = "1.0";
export const A2A_CONTENT_TYPE = "application/a2a+json";
export const A2A_VERSION_HEADER = "A2A-Version";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * Task states that represent a terminal (final) condition.
 * Once a task reaches one of these states it will not transition further.
 */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
