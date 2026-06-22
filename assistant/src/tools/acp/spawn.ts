import { basename } from "node:path";

import { resolveAgentWithAutoInstall } from "../../acp/auto-install.js";
import { getAcpSessionManager } from "../../acp/index.js";
import { prepareAgentEnv } from "../../acp/prepare-agent-env.js";
import { formatResolveFailure } from "../../acp/resolve-agent.js";
import { claudeResumeHint } from "../../acp/resume-hint.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { getSendToClient } from "./context.js";

export async function executeAcpSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const agent = (input.agent as string) || "claude";
  const task = input.task as string;

  if (!task) {
    return { content: '"task" is required.', isError: true };
  }

  // Pure precondition: check for a connected client BEFORE any side effects
  // (auto-install mutates the host via a `bun` global install and can block
  // for up to the install timeout). Without a client the spawn cannot
  // succeed anyway.
  const sendToClient = getSendToClient(context);
  if (!sendToClient) {
    return {
      content: "No client connected - cannot spawn ACP agent.",
      isError: true,
    };
  }

  // Resolve the agent, silently auto-installing a missing allowlisted
  // adapter binary (see acp/auto-install.ts). Shared with the HTTP route.
  const { resolved, autoInstalledPackage, failureMessage } =
    await resolveAgentWithAutoInstall(agent);
  if (failureMessage) {
    return { content: failureMessage, isError: true };
  }
  if (!resolved.ok) {
    return { content: formatResolveFailure(agent, resolved), isError: true };
  }

  // Inject required env vars and preflight via the shared helper. Mirrors
  // the HTTP route at `runtime/routes/acp-routes.ts:spawnSession` — both
  // call sites MUST go through `prepareAgentEnv` before `manager.spawn`,
  // otherwise the spawned subprocess starts with no auth and dies as a
  // zombie after the first prompt. See `acp/prepare-agent-env.ts` for
  // the full rationale.
  let agentConfig;
  try {
    agentConfig = await prepareAgentEnv(resolved.agent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
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
      sendToClient,
    );

    // Claude Code-only resume hint; empty for other adapters. Keyed off the
    // resolved command basename (always the real adapter binary). See
    // acp/resume-hint.ts for the gating rationale.
    const hint = claudeResumeHint(
      basename(agentConfig.command),
      cwd,
      protocolSessionId,
    );
    const resumeHint = hint ? ` ${hint}` : "";
    const installNote = autoInstalledPackage
      ? ` Installed ${autoInstalledPackage} automatically.`
      : "";
    const payload = JSON.stringify({
      acpSessionId,
      protocolSessionId,
      agent,
      cwd,
      status: "running",
      message:
        `ACP agent "${agent}" spawned (session: ${protocolSessionId}). ` +
        `Results stream back via SSE. You will be notified when it completes.` +
        `${installNote}${resumeHint}`,
    });

    return { content: payload, isError: false };
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
