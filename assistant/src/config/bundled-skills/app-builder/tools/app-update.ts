import { setAppCommitMessage } from "../../../../apps/app-git-service.js";
import * as appStore from "../../../../apps/app-store.js";
import type { AppUpdateInput } from "../../../../tools/apps/executors.js";
import { executeAppUpdate } from "../../../../tools/apps/executors.js";
import {
  missingAppIdError,
  resolveAppId,
} from "../../../../tools/apps/resolve-app-id.js";
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
  const appId = resolveAppId(input, context.conversationId);
  if (!appId) return missingAppIdError();
  return executeAppUpdate(
    { ...input, app_id: appId } as unknown as AppUpdateInput,
    appStore,
  );
}
