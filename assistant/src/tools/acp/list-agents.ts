import { listAcpAgents } from "../../acp/resolve-agent.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Lists ACP coding agents available to spawn (configured + bundled defaults),
 * marking each with its source (`config` vs `default`), whether the agent's
 * binary is on PATH, and an install hint when missing.
 */
export async function executeAcpListAgents(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const { agents } = listAcpAgents();

  return {
    content: JSON.stringify({ agents }),
    isError: false,
  };
}
