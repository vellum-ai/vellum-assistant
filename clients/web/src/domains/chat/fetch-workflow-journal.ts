/**
 * Fetch a workflow run's journal from the daemon.
 *
 * The response is validated at the network boundary against the canonical
 * `WorkflowJournalResponseSchema`, so consumers receive a typed, trusted
 * shape instead of the SDK's pre-schema `unknown` payload.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  WorkflowJournalResponseSchema,
  type WorkflowJournalResponse,
} from "@vellumai/assistant-api";

import { workflowsRunsByIdJournalGet } from "@/generated/daemon/sdk.gen";

export async function fetchWorkflowJournal(
  assistantId: string,
  runId: string,
): Promise<WorkflowJournalResponse | null> {
  try {
    const { data, response } = await workflowsRunsByIdJournalGet({
      path: { assistant_id: assistantId, id: runId },
      throwOnError: false,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    const parsed = WorkflowJournalResponseSchema.safeParse(data);
    if (!parsed.success) {
      captureError(parsed.error, { context: "fetchWorkflowJournal" });
      return null;
    }
    return parsed.data;
  } catch (err) {
    captureError(err, { context: "fetchWorkflowJournal" });
    return null;
  }
}
