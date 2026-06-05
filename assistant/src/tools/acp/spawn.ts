import {
  execFileWithTimeout,
  resolveAgentWithAutoInstall,
} from "../../acp/auto-install.js";
import { getAcpSessionManager } from "../../acp/index.js";
import { prepareAgentEnv } from "../../acp/prepare-agent-env.js";
import { formatResolveFailure } from "../../acp/resolve-agent.js";
import { claudeResumeHint } from "../../acp/resume-hint.js";
import { DEFAULT_AGENT_NPM_PACKAGES } from "../../config/acp-defaults.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { getSendToClient } from "./context.js";

const log = getLogger("acp:spawn");

/** Per-call timeout for `npm` probes. Best-effort: timeouts are non-fatal. */
const NPM_PROBE_TIMEOUT_MS = 5_000;

/**
 * Cache of resolved version-check outcomes — including `null` for "skipped" —
 * keyed by command. Lives for the process lifetime so retries don't reprobe.
 */
const adapterVersionCache = new Map<string, AdapterVersionInfo | null>();

interface AdapterVersionInfo {
  outdated: true;
  installed: string;
  latest: string;
  packageName: string;
}

/**
 * Checks if the globally-installed ACP adapter for `command` is outdated.
 * Best-effort: any error or timeout returns `null` (skipped). Unknown
 * commands also return `null`. Results are cached per-command for the
 * process lifetime.
 *
 * Note: `npm ls -g` doesn't see Homebrew/tarball installs, so a "not found"
 * here doesn't mean the binary is missing — it just means we can't compare
 * versions. The caller must NEVER block the spawn on this result.
 */
async function checkAdapterVersion(
  command: string,
): Promise<AdapterVersionInfo | null> {
  if (adapterVersionCache.has(command)) {
    return adapterVersionCache.get(command) ?? null;
  }

  const packageName = DEFAULT_AGENT_NPM_PACKAGES[command];
  if (!packageName) {
    adapterVersionCache.set(command, null);
    return null;
  }

  try {
    const [installedRaw, latestRaw] = await Promise.all([
      execFileWithTimeout(
        "npm",
        ["ls", "-g", "--json", packageName],
        NPM_PROBE_TIMEOUT_MS,
      ),
      execFileWithTimeout(
        "npm",
        ["view", packageName, "version"],
        NPM_PROBE_TIMEOUT_MS,
      ),
    ]);

    const installed =
      JSON.parse(installedRaw)?.dependencies?.[packageName]?.version;
    const latest = latestRaw.trim();

    if (!installed || !latest || installed === latest) {
      adapterVersionCache.set(command, null);
      return null;
    }

    log.info({ installed, latest, packageName }, "ACP adapter is outdated");
    const info: AdapterVersionInfo = {
      outdated: true,
      installed,
      latest,
      packageName,
    };
    adapterVersionCache.set(command, info);
    return info;
  } catch (err) {
    log.warn(
      { err, packageName },
      "Failed to check ACP adapter version (best-effort, skipping)",
    );
    adapterVersionCache.set(command, null);
    return null;
  }
}

/** @internal — exposed for tests only. */
export function _resetAdapterVersionCacheForTests(): void {
  adapterVersionCache.clear();
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

  // Pure precondition: check for a connected client BEFORE any side effects
  // (auto-install mutates the host via `npm i -g` and can block for up to
  // the install timeout). Without a client the spawn cannot succeed anyway.
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

  // Best-effort version check — never blocks the spawn. If outdated, we
  // append a non-blocking warning to the success payload.
  const versionInfo = await checkAdapterVersion(agentConfig.command);

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

    // Claude Code-only resume hint; empty for other adapters. See
    // acp/resume-hint.ts for the gating rationale.
    const hint = claudeResumeHint(agentConfig.command, cwd, protocolSessionId);
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

    let content = payload;
    if (versionInfo) {
      content +=
        `\n\nNote: ${versionInfo.packageName} is outdated ` +
        `(installed: ${versionInfo.installed}, latest: ${versionInfo.latest}). ` +
        `To update, run: npm install -g ${versionInfo.packageName}@${versionInfo.latest}`;
    }

    return { content, isError: false };
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
