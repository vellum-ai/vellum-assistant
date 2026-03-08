import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeWatcherUpdate } from "../../../../tools/watcher/update.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeWatcherUpdate(input, context);
}
