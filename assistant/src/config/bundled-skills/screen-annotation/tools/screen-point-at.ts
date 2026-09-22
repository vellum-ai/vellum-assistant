/**
 * Point at things on the surface a call is being shown.
 *
 * Forwarded as `computer_use_point_at` rather than under its own name:
 * `surfaceProxyResolver` routes tools by that prefix to the connected desktop
 * client, and the client answers this one in its own main process because the
 * marks are drawn on a window it owns. The name the model sees belongs to
 * this skill; the name on the wire is the route.
 */

import {
  forwardComputerUseProxyTool,
  POINT_AT_PROXY_TOOL,
} from "../../../../tools/computer-use/skill-proxy-bridge.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return forwardComputerUseProxyTool(POINT_AT_PROXY_TOOL, input, context);
}
