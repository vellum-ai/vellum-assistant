import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeWatcherDigest } from "../../../../tools/watcher/digest.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeWatcherDigest(input, context);
}
