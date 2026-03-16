import { getAcpSessionManager } from "../../acp/index.js";
import { getConfig } from "../../config/loader.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeAcpSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const agent = (input.agent as string) || "claude";
  const task = input.task as string;

  if (!task) {
    return { content: '"task" is required.', isError: true };
  }

  const config = getConfig();
  if (!config.acp?.enabled) {
    return { content: "ACP is not enabled in config.", isError: true };
  }

  const agentConfig = config.acp.agents[agent];
  if (!agentConfig) {
    const available = Object.keys(config.acp.agents).join(", ") || "none";
    return {
      content: `Unknown agent "${agent}". Available: ${available}`,
      isError: true,
    };
  }

  const sendToClient = context.sendToClient as
    | ((msg: { type: string; [key: string]: unknown }) => void)
    | undefined;
  if (!sendToClient) {
    return {
      content: "No client connected — cannot spawn ACP agent.",
      isError: true,
    };
  }

  try {
    const manager = getAcpSessionManager();
    const cwd = (input.cwd as string) || context.workingDir;
    const { acpSessionId, protocolSessionId } = await manager.spawn(
      agent,
      agentConfig,
      task,
      cwd,
      context.sessionId,
      sendToClient as (msg: unknown) => void,
    );

    return {
      content: JSON.stringify({
        acpSessionId,
        protocolSessionId,
        agent,
        status: "running",
        message: `ACP agent "${agent}" spawned (session: ${protocolSessionId}). Results stream back via SSE. You can resume this session later with: claude --resume ${protocolSessionId}`,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn ACP agent: ${msg}`, isError: true };
  }
}
