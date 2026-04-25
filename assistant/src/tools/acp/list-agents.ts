import { listAcpAgents } from "../../acp/resolve-agent.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Lists ACP coding agents available to spawn (configured + bundled defaults),
 * marking each with its source (`config` vs `default`), whether the agent's
 * binary is on PATH, and an install hint when missing.
 *
 * When `acp.enabled: false`, returns a single hint instructing the user to
 * enable ACP — no agent list is surfaced because none can run.
 */
export async function executeAcpListAgents(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const { enabled, agents } = listAcpAgents();
  if (!enabled) {
    return {
      content: JSON.stringify({
        enabled: false,
        hint: "Set 'acp.enabled': true to use ACP agents.",
      }),
      isError: false,
    };
  }

  return {
    content: JSON.stringify({ enabled, agents }),
    isError: false,
  };
}
