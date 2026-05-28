/**
 * Logical call-site identifiers stamped onto every `llm_request_log` row
 * (column `call_site` — migration 264). The inspector branches on this
 * value alone to distinguish real LLM calls (`mainAgent`,
 * `compactionAgent`, …) from synthetic agent-error-message rows.
 *
 * The constants below are the wire contract; both backend (when writing
 * a row) and frontend (when rendering one) must reference the same
 * literal. Add new call sites here as new emit sites appear.
 */

/**
 * Marks a synthetic assistant error-message row — one the agent loop
 * emitted because something went wrong (budget yield, out of funds, …)
 * with no underlying LLM call. All such events cause the loop to exit,
 * so a single generic bucket plus the existing `agent_loop_exit_reason`
 * column is enough to discriminate which kind of error fired
 * (`budget_yield_unrecovered`, future out-of-funds, etc.).
 *
 * Intentionally *not* a member of the backend's `LLMCallSite` enum:
 * that enum binds config lookup, not the shape of the `call_site`
 * column. Compaction-route filters that match
 * `call_site = 'compactionAgent'` already treat this value as a
 * non-compaction call, which is the desired floor-lookup behavior.
 */
export const CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE =
  "syntheticAgentErrorMessage";
