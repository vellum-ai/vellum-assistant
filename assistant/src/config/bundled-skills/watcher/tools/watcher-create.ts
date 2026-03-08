import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeWatcherCreate } from "../../../../tools/watcher/create.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeWatcherCreate(input, context);
}
