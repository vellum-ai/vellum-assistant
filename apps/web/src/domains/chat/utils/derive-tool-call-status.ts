import type { ConversationMessageToolCall } from "@vellumai/assistant-api";

export type ToolCallStatus = "running" | "completed" | "error";

/**
 * Derive a tool call's execution state from the wire fields the daemon already
 * carries. `status` is not stored on the tool call; it is a pure function of
 * `isError`, `result`, and `completedAt`:
 *
 * - `isError` truthy → `"error"` (an errored result, however it was produced).
 * - otherwise a `result` payload OR a `completedAt` timestamp → `"completed"`.
 *   `completedAt` covers force-completion — a tool finalized at
 *   `message_complete` / reconcile without ever receiving result data, which
 *   stamps the timestamp but leaves `result` undefined.
 * - neither → `"running"`.
 */
export function deriveToolCallStatus(
  tc: Pick<ConversationMessageToolCall, "isError" | "result" | "completedAt">,
): ToolCallStatus {
  if (tc.isError) {
    return "error";
  }
  if (tc.result !== undefined || tc.completedAt != null) {
    return "completed";
  }
  return "running";
}
