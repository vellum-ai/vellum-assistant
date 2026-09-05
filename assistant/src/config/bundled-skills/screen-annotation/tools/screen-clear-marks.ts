/**
 * Take down whatever is drawn on the shared surface.
 *
 * Its own tool rather than an empty `marks` array on the pointing one,
 * because clearing is a thing the model decides to do rather than a shape of
 * argument it has to remember. On the wire it is the same request carrying
 * nothing, which is how the client says "nothing is being pointed at".
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
  return forwardComputerUseProxyTool(
    POINT_AT_PROXY_TOOL,
    {
      ...(typeof input.target_client_id === "string"
        ? { target_client_id: input.target_client_id }
        : {}),
      marks: [],
    },
    context,
  );
}
