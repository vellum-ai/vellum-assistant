import { forwardComputerUseProxyTool } from "../../../../tools/computer-use/skill-proxy-bridge.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const CLICK_TYPE_TO_PROXY_TOOL: Record<string, string> = {
  single: "computer_use_click",
  double: "computer_use_double_click",
  right: "computer_use_right_click",
};

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const clickType = (input.click_type as string | undefined) ?? "single";
  const proxyToolName =
    CLICK_TYPE_TO_PROXY_TOOL[clickType] ?? "computer_use_click";
  return forwardComputerUseProxyTool(proxyToolName, input, context);
}
