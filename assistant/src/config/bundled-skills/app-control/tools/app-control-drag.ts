import { forwardAppControlProxyTool } from "../../../../tools/app-control/skill-proxy-bridge.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return forwardAppControlProxyTool("app_control_drag", input, context);
}
