import { executeBrowserType } from "../../../assistant/src/tools/browser/browser-execution.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../assistant/src/tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeBrowserType(input, context);
}
