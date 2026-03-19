import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getAcpSessionManager } from "../../acp/index.js";
import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const execFileAsync = promisify(execFile);
const log = getLogger("acp:spawn");

/** Cache so we only check once per process lifetime. */
let adapterVersionChecked = false;

interface AdapterVersionInfo {
  outdated: true;
  installed: string;
  latest: string;
}

/**
 * Checks if the globally-installed claude-agent-acp adapter is outdated.
 * Runs at most once per process lifetime. Does NOT auto-update — returns
 * version info so the caller can ask the user first.
 */
async function checkAdapterVersion(
  command: string,
): Promise<AdapterVersionInfo | null> {
  if (adapterVersionChecked || command !== "claude-agent-acp") {
    return null;
  }
  adapterVersionChecked = true;

  try {
    const { stdout: installedRaw } = await execFileAsync("npm", [
      "ls",
      "-g",
      "--json",
      "@zed-industries/claude-agent-acp",
    ]);
    const { stdout: latestRaw } = await execFileAsync("npm", [
      "view",
      "@zed-industries/claude-agent-acp",
      "version",
    ]);

    const installed =
      JSON.parse(installedRaw)?.dependencies?.[
        "@zed-industries/claude-agent-acp"
      ]?.version;
    const latest = latestRaw.trim();

    if (!installed || !latest || installed === latest) {
      return null;
    }

    log.info({ installed, latest }, "claude-agent-acp is outdated");
    return { outdated: true, installed, latest };
  } catch (err) {
    log.warn({ err }, "Failed to check claude-agent-acp version");
    return null;
  }
}

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
      content: "No client connected - cannot spawn ACP agent.",
      isError: true,
    };
  }

  // Check if the ACP adapter is outdated before spawning
  const versionInfo = await checkAdapterVersion(agentConfig.command);
  if (versionInfo) {
    return {
      content:
        `claude-agent-acp is outdated (installed: ${versionInfo.installed}, latest: ${versionInfo.latest}). ` +
        `Ask the user if they'd like to update. If yes, call the acp_update_adapter tool, then retry acp_spawn.`,
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
      context.conversationId,
      sendToClient as (msg: unknown) => void,
    );

    return {
      content: JSON.stringify({
        acpSessionId,
        protocolSessionId,
        agent,
        cwd,
        status: "running",
        message:
          `ACP agent "${agent}" spawned (session: ${protocolSessionId}). ` +
          `Results stream back via SSE. You will be notified when it completes. ` +
          `To resume this session later, run: cd ${cwd} && claude --resume ${protocolSessionId}`,
      }),
      isError: false,
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== undefined
          ? JSON.stringify(err)
          : String(err);
    return { content: `Failed to spawn ACP agent: ${msg}`, isError: true };
  }
}

/**
 * Updates the globally-installed claude-agent-acp adapter to the latest version.
 * Called by the LLM after the user confirms the update.
 */
export async function executeAcpUpdateAdapter(): Promise<ToolExecutionResult> {
  try {
    const { stdout: latestRaw } = await execFileAsync("npm", [
      "view",
      "@zed-industries/claude-agent-acp",
      "version",
    ]);
    const latest = latestRaw.trim();

    await execFileAsync("npm", [
      "install",
      "-g",
      `@zed-industries/claude-agent-acp@${latest}`,
    ]);

    log.info({ latest }, "claude-agent-acp updated");
    // Reset the check so the next spawn sees it as current
    adapterVersionChecked = false;

    return {
      content: `claude-agent-acp updated to ${latest}. You can now retry acp_spawn.`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to update claude-agent-acp: ${msg}`,
      isError: true,
    };
  }
}
