import { isAssistantFeatureFlagEnabled } from "../../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../../config/loader.js";
import { setAppCommitMessage } from "../../../../memory/app-git-service.js";
import * as appStore from "../../../../memory/app-store.js";
import type { AppCreateInput } from "../../../../tools/apps/executors.js";
import { executeAppCreate } from "../../../../tools/apps/executors.js";
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
  const multifileEnabled = isAssistantFeatureFlagEnabled(
    "app-builder-multifile",
    getConfig(),
  );
  const createInput: AppCreateInput = {
    ...(input as unknown as AppCreateInput),
    featureFlags: { multifileEnabled },
  };
  return executeAppCreate(createInput, appStore, context.proxyToolResolver);
}
