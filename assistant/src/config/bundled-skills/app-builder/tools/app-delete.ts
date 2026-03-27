import { setAppCommitMessage } from "../../../../memory/app-git-service.js";
import * as appStore from "../../../../memory/app-store.js";
import { executeAppDelete } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (typeof input.change_summary === "string" && input.change_summary.trim()) {
    setAppCommitMessage(context.conversationId, input.change_summary.trim());
  }
  return executeAppDelete({ app_id: input.app_id as string }, appStore);
}
