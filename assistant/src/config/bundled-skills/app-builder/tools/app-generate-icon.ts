import * as appStore from "../../../../apps/app-store.js";
import type { AppGenerateIconInput } from "../../../../tools/apps/executors.js";
import { executeAppGenerateIcon } from "../../../../tools/apps/executors.js";
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
  const appId = resolveAppId(input, context.conversationId);
  if (!appId) return missingAppIdError();
  return executeAppGenerateIcon(
    { ...input, app_id: appId } as unknown as AppGenerateIconInput,
    appStore,
  );
}
