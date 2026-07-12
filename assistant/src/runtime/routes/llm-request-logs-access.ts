/**
 * Shared access guard for the inspector's LLM-request-log read routes.
 *
 * When `llmRequestLogs.enabled` is `false` there is nothing to serve (and any
 * rows that predate the opt-out are intentionally withheld), so every route
 * that surfaces LLM-derived log data — the message/conversation `llm-context`
 * routes, the single-log payload/context routes, and the compaction trail
 * route — calls this first to fail fast with the distinct
 * `LLM_REQUEST_LOGS_DISABLED` code the client keys on to render an
 * enable-logging affordance instead of a generic error.
 */
import { getConfig } from "../../config/loader.js";
import { LlmRequestLogsDisabledError } from "./errors.js";

export function assertLlmRequestLoggingEnabled(): void {
  if (getConfig().llmRequestLogs?.enabled === false) {
    throw new LlmRequestLogsDisabledError();
  }
}
