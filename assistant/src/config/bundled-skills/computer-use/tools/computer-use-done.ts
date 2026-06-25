import { forwardComputerUseProxyTool } from "../../../../tools/computer-use/skill-proxy-bridge.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return forwardComputerUseProxyTool("computer_use_done", input, context);
}
