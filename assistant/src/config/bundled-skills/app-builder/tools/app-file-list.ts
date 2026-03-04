import * as appStore from "../../../../memory/app-store.js";
import { executeAppFileList } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppFileList({ app_id: input.app_id as string }, appStore);
}
