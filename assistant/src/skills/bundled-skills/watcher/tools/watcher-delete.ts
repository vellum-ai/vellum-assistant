import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeWatcherDelete } from "../../../../tools/watcher/delete.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeWatcherDelete(input, context);
}
