import { forwardAppControlProxyTool } from "../../../../tools/app-control/skill-proxy-bridge.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return forwardAppControlProxyTool("app_control_type", input, context);
}
