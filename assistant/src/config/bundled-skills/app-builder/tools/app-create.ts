import * as appStore from "../../../../apps/app-store.js";
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
  const createInput: AppCreateInput = input as unknown as AppCreateInput;
  return executeAppCreate(
    createInput,
    appStore,
    context.proxyToolResolver,
    context.conversationId,
  );
}
