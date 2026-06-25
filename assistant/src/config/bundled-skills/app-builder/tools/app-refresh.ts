import { setAppCommitMessage } from "../../../../memory/app-git-service.js";
import * as appStore from "../../../../memory/app-store.js";
import { executeAppRefresh } from "../../../../tools/apps/executors.js";
import {
  missingAppIdError,
  resolveAppId,
} from "../../../../tools/apps/resolve-app-id.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  if (typeof input.change_summary === "string" && input.change_summary.trim()) {
    setAppCommitMessage(context.conversationId, input.change_summary.trim());
  }
  const appId = resolveAppId(input, context.conversationId);
  if (!appId) return missingAppIdError();
  return executeAppRefresh({ app_id: appId }, appStore);
}
