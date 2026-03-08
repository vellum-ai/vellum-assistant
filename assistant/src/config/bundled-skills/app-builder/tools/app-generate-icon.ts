import * as appStore from "../../../../memory/app-store.js";
import type { AppGenerateIconInput } from "../../../../tools/apps/executors.js";
import { executeAppGenerateIcon } from "../../../../tools/apps/executors.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return executeAppGenerateIcon(
    input as unknown as AppGenerateIconInput,
    appStore,
  );
}
