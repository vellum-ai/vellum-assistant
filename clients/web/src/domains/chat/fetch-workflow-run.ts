/**
 * Fetch a single workflow run row from the daemon.
 *
 * Distinguishes three outcomes so the caller can retry transient failures
 * without re-spamming genuinely-unknown runs:
 *
 * - the SDK-typed run object on a successful response,
 * - `"not_found"` when the run genuinely does not exist (HTTP 404),
 * - `null` for a transient/retryable failure (unreachable daemon, 5xx, thrown).
 *
 * Used to hydrate the workflow store for runs that are only recoverable from a
 * persisted `run_workflow` tool result (history / post-reload), where no live
 * `workflow_started` event replays.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { workflowsRunsByIdGet } from "@/generated/daemon/sdk.gen";
import type { WorkflowsRunsByIdGetResponses } from "@/generated/daemon/types.gen";

export type WorkflowRunRow = WorkflowsRunsByIdGetResponses[200];

export type FetchWorkflowRunResult = WorkflowRunRow | "not_found" | null;

export async function fetchWorkflowRun(
  assistantId: string,
  runId: string,
): Promise<FetchWorkflowRunResult> {
  try {
    const { data, response } = await workflowsRunsByIdGet({
      path: { assistant_id: assistantId, id: runId },
      throwOnError: false,
    });
    if (response?.ok && data) {
      return data;
    }
    // A definitive 404 means the run is gone; anything else (no response, 5xx)
    // is transient and should be retried on a later mount.
    if (response?.status === 404) {
      return "not_found";
    }
    return null;
  } catch (err) {
    captureError(err, { context: "fetchWorkflowRun" });
    return null;
  }
}
