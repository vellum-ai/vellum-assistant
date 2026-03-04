import * as appStore from "../../../../memory/app-store.js";
import { executeAppList } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppList(appStore);
}
