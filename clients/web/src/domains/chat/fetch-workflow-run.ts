/**
 * Fetch a single workflow run row from the daemon.
 *
 * Returns the SDK-typed run object on a successful response, or `null`
 * when the run is unknown (404) or the request fails. Used to hydrate the
 * workflow store for runs that are only recoverable from a persisted
 * `run_workflow` tool result (history / post-reload), where no live
 * `workflow_started` event replays.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { workflowsRunsByIdGet } from "@/generated/daemon/sdk.gen";
import type { WorkflowsRunsByIdGetResponses } from "@/generated/daemon/types.gen";

export type WorkflowRunRow = WorkflowsRunsByIdGetResponses[200];

export async function fetchWorkflowRun(
  assistantId: string,
  runId: string,
): Promise<WorkflowRunRow | null> {
  try {
    const { data, response } = await workflowsRunsByIdGet({
      path: { assistant_id: assistantId, id: runId },
      throwOnError: false,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    return data;
  } catch (err) {
    captureError(err, { context: "fetchWorkflowRun" });
    return null;
  }
}
