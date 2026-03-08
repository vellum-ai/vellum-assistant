import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeWatcherList } from "../../../../tools/watcher/list.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeWatcherList(input, context);
}
