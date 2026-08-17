import { basename } from "node:path";

import { z } from "zod";

import { markAcpConnectCardRaised } from "../../acp/acp-connect-card-state.js";
import {
  ACP_AUTH_RECOVERY_GUIDANCE,
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  CLAUDE_ACP_COMMAND,
  isAcpAuthRequired,
} from "../../acp/auth-required.js";
import { resolveAgentWithAutoInstall } from "../../acp/auto-install.js";
import { getAcpSessionManager } from "../../acp/index.js";
import {
  ACP_CLAUDE_OAUTH_MISSING_CODE,
  prepareAgentEnv,
} from "../../acp/prepare-agent-env.js";
import { formatResolveFailure } from "../../acp/resolve-agent.js";
import { claudeResumeHint } from "../../acp/resume-hint.js";
import { FailedDependencyError } from "../../runtime/routes/errors.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { getSendToClient } from "./context.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeAcpSpawn}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools — see the schema block in `tools/document/document-tool.ts` for the
 * framework. The bespoke '"task" is required.' check keeps its message for
 * the missing/null/empty cases.
 */
export const acpSpawnInputSchema = z.looseObject({
  agent: nullAsOmitted(z.string()),
  task: nullAsOmitted(z.string()),
  cwd: nullAsOmitted(z.string()),
});

/**
 * Recover the stable `acp_claude_oauth_missing` marker off a `prepareAgentEnv`
 * failure so the tool result can carry it as a structured `errorCode` instead
 * of the client re-parsing the human message string.
 */
function acpSpawnErrorCode(err: unknown): string | undefined {
  if (
    err instanceof FailedDependencyError &&
    typeof err.details === "object" &&
    err.details !== null &&
    (err.details as { code?: unknown }).code === ACP_CLAUDE_OAUTH_MISSING_CODE
  ) {
    return ACP_CLAUDE_OAUTH_MISSING_CODE;
  }
  return undefined;
}

export async function executeAcpSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpSpawnInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_spawn", parsedInput.error);
  }
  const agent = parsedInput.data.agent || "claude";
  const task = parsedInput.data.task;

  if (!task) {
    return { content: '"task" is required.', isError: true };
  }

  // Pure precondition: the session streams its results through the
  // conversation's event sink, so a context with no sink at all (a tool run
  // outside any conversation, e.g. the standalone CLI runner) cannot host a
  // spawn. Checked BEFORE any side effects (auto-install mutates the host via
  // a `bun` global install and can block for up to the install timeout).
  // Inside a conversation the sink always exists and is always live.
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
    const errorCode = acpSpawnErrorCode(err);
    if (errorCode === ACP_CLAUDE_OAUTH_MISSING_CODE) {
      // This failure raises the inline Connect card. Record it so the
      // credential-prompt route only redirects a redundant secure-prompt when a
      // card actually exists (not for a proactive prompt before any failure).
      markAcpConnectCardRaised(context.conversationId);
    }
    return { content: msg, isError: true, ...(errorCode ? { errorCode } : {}) };
  }

  try {
    const manager = getAcpSessionManager();
    const cwd = parsedInput.data.cwd || context.workingDir;
    const { acpSessionId, protocolSessionId } = await manager.spawn(
      agent,
      agentConfig,
      task,
      cwd,
      context.conversationId,
      sendToClient,
      context.toolUseId,
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
    // A pre-spawn rejection of the stored Claude credential (the adapter
    // raises auth_required during session creation) gets the same recovery
    // surface as the missing-token preflight: the errorCode raises the inline
    // Connect card off this failed tool call, the registry mark dedups a
    // redundant secure prompt, and the guidance keeps the model pointed at
    // the card. Adapter-gated: the card repairs Claude credentials only.
    // `isAcpAuthRequired` rather than an instanceof: it also recognizes the
    // raw JSON-RPC auth_required object, which is how a rejection reaches
    // this catch from the one protocol call `withAuthRetry` cannot wrap
    // (`initialize`, whose response is what advertises the auth methods the
    // retry would need).
    if (
      isAcpAuthRequired(err) &&
      basename(agentConfig.command) === CLAUDE_ACP_COMMAND
    ) {
      const message =
        err instanceof Error
          ? err.message
          : String((err as { message?: unknown }).message ?? err);
      markAcpConnectCardRaised(context.conversationId);
      return {
        content: `${message}\n\n${ACP_AUTH_RECOVERY_GUIDANCE}`,
        isError: true,
        errorCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
      };
    }
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== undefined
          ? JSON.stringify(err)
          : String(err);
    return { content: `Failed to spawn ACP agent: ${msg}`, isError: true };
  }
}
