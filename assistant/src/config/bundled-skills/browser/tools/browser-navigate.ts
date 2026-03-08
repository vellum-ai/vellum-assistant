import { executeBrowserNavigate } from "../../../../tools/browser/browser-execution.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeBrowserNavigate(input, context);
}
