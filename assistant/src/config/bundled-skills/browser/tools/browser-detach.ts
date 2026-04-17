import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { runBrowserTool } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return runBrowserTool("browser_detach", input, context);
}
