import { forwardComputerUseProxyTool } from "../../../../tools/computer-use/skill-proxy-bridge.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return forwardComputerUseProxyTool(
    "computer_use_double_click",
    input,
    context,
  );
}
