import * as appStore from "../../../../memory/app-store.js";
import type { AppFileWriteInput } from "../../../../tools/apps/executors.js";
import { executeAppFileWrite } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppFileWrite(input as unknown as AppFileWriteInput, appStore);
}
