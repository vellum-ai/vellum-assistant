/**
 * Default cap (in seconds) on how long a single tool invocation may run
 * before the assistant aborts it with a synthetic error result. This is
 * the canonical default for the `timeouts.toolExecutionTimeoutSec` config
 * field and the fallback used by `executeWithTimeout` when the config
 * value is missing or invalid.
 *
 * Exposed on the API surface so frontend consumers — chiefly
 * `sanitizeDisplayMessages` in the web client — can recognise tool
 * calls whose live tracking outlives any plausible server-side
 * execution and mark them as failed instead of spinning forever. The
 * canonical case is an assistant restart mid-tool: the daemon never
 * delivers the `tool_result` SSE, the client retains
 * `status: "running"`, and the bubble would otherwise stall the UI
 * across the restart boundary.
 *
 * Treat this as the wire contract for the default. Callers that need a
 * different ceiling should still read the deployed config — this
 * constant is only authoritative when the config doesn't override it.
 */
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC = 120;
