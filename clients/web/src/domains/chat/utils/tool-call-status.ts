import type { ConversationMessageToolCall } from "@vellumai/assistant-api";

type ToolCallStateFields = Pick<
  ConversationMessageToolCall,
  "isError" | "result" | "completedAt"
>;

/**
 * A tool call is still running until it carries a terminal signal.
 *
 * We must check BOTH `result` and `completedAt` (not just one) because the
 * daemon can persist one without the other: `renderHistoryContent` pairs
 * `result` in from a separate `tool_result` block, while `completedAt` comes
 * only from `_completedAt` stamped on the `tool_use` block — independent
 * sources that can disagree. Force-completion stamps `completedAt` with no
 * result; older history rows carry a result with no `completedAt`. `isError`
 * short-circuits to a terminal (errored) state regardless.
 *
 * This defensive read should collapse to a single field check once the daemon
 * stamps the terminal fields consistently — see
 * https://github.com/vellum-ai/vellum-assistant/issues/33501.
 */
export function isToolCallRunning(tc: ToolCallStateFields): boolean {
  return !tc.isError && tc.result === undefined && tc.completedAt == null;
}

/** A tool call that has finished without erroring. */
export function isToolCallCompleted(tc: ToolCallStateFields): boolean {
  return !tc.isError && !isToolCallRunning(tc);
}

/**
 * Terminal-state precedence for reconciling two copies of the same tool call:
 * `error` (2) outranks `completed` (1) outranks `running` (0). Used to keep the
 * more-final copy during merge and to upgrade monotonically during reconcile
 * (never downgrade `completed`/`error` back to `running`).
 */
export function toolCallRank(tc: ToolCallStateFields): number {
  if (tc.isError) {
    return 2;
  }
  if (isToolCallRunning(tc)) {
    return 0;
  }
  return 1;
}
