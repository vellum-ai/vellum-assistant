import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { screenWatchTool } from "../../../../tools/watch/screen-watch.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return screenWatchTool.execute(input, context);
}
