import { formatDesktopAppRequired } from "../capability-offer.js";
import { throwIfCancelled } from "../shared/abort.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { computerUseTarget } from "./target.js";

/**
 * The wire name the screen-annotation skill's tools forward under.
 *
 * A `computer_use_` name because that prefix is what `surfaceProxyResolver`
 * routes to the connected desktop client, not because pointing is computer
 * use. It is named here rather than in the skill so the resolver can exempt
 * it from the computer-use step budget without importing a bundled skill.
 */
export const POINT_AT_PROXY_TOOL = "computer_use_point_at";

/**
 * Session teardown, which runs even on a cancelled turn: refusing it would
 * leave the computer-use session the model opened running with nothing left to
 * close it. Keyed on the wire name, so a caller whose wire name it shares with
 * an actuating tool says so with `opts.teardown` instead.
 */
const TEARDOWN_TOOLS: ReadonlySet<string> = new Set(["computer_use_done"]);

/** Dispatch to the explicit computer target; omitted targets use the host. */
export async function forwardComputerUseProxyTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
  opts?: { teardown?: boolean },
): Promise<ToolExecutionResult> {
  if (!opts?.teardown && !TEARDOWN_TOOLS.has(toolName)) {
    throwIfCancelled(context);
  }
  const target = computerUseTarget(input);
  if (target === "assistant-desktop") {
    const { executeAssistantDesktopTool } =
      await import("./assistant-desktop-backend.js");
    return executeAssistantDesktopTool(toolName, input, context);
  }
  if (!context.proxyToolResolver) {
    return {
      content: formatDesktopAppRequired("screen"),
      isError: true,
    };
  }
  const { target: _target, ...hostInput } = input;
  return context.proxyToolResolver(toolName, hostInput);
}
