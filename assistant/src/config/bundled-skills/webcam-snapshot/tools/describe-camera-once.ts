import { forwardHostCameraProxyTool } from "../../../../tools/host-camera/skill-proxy-bridge.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return forwardHostCameraProxyTool("describe_camera_once", input, context);
}
