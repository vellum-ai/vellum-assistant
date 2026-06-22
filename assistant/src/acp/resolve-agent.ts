/**
 * Shared resolver for ACP agent ids → agent config + binary preflight.
 *
 * `resolveAcpAgent(id)` merges user-provided `config.acp.agents[id]` (wins on
 * overlap) with the bundled `DEFAULT_ACP_AGENT_PROFILES` so common agents like
 * `claude` and `codex` Just Work with no per-user config required. Natural
 * names ("claude code", "Gemini CLI") resolve via `AGENT_ID_ALIASES` when the
 * raw id misses both maps. The result is a discriminated union covering every
 * reason a spawn might fail before we even start the agent process: unknown
 * agent id, or binary missing from PATH. Callers (acp_spawn, acp_list_agents,
 * and the `/v1/acp/spawn` HTTP route) get a single source of truth and
 * matching actionable hints.
 *
 * The resolver NEVER fetches or runs packages in the (untrusted) task cwd.
 * When the adapter binary is missing, resolution simply fails with
 * `binary_not_found`; the `resolveAgentWithAutoInstall` flow in
 * `auto-install.ts` then performs a one-time sandboxed `bun` global install
 * (clean temp cwd, secrets stripped from the installer env) and re-resolves.
 * The resolved command is therefore ALWAYS the real adapter binary on PATH,
 * so downstream gates (env injection, resume hints) key off the command
 * basename directly.
 *
 * `listAcpAgents()` exposes the merged catalog with availability info for
 * the `acp_list_agents` tool — same merge semantics, plus per-entry
 * `available` / `setupHint` derived from the same binary resolution.
 */

import {
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_NPM_PACKAGES,
} from "../config/acp-defaults.js";
import type { AcpAgentConfig } from "../config/acp-schema.js";
import { getConfig } from "../config/loader.js";

/**
 * Whether this agent's entry came from user config (wins over default) or
 * fell back to the bundled default profile. Surfaced in `acp_list_agents`
 * output so users can see at a glance which agents they've customized.
 */
type AcpAgentSource = "config" | "default";

export type ResolveAcpAgentResult =
  | { ok: true; agent: AcpAgentConfig }
  | ResolveAcpAgentFailure;

export type ResolveAcpAgentFailure =
  | { ok: false; reason: "unknown_agent"; available: string[] }
  | {
      ok: false;
      reason: "binary_not_found";
      hint: string;
      command: string;
    };

/**
 * Single source of truth for the user-facing message of each resolver
 * failure reason. Every caller that surfaces a resolve failure (acp_spawn
 * tool, /v1/acp/spawn route, AcpSessionManager.resumeFromHistory) renders
 * the same copy through this helper; only the transport wrapping (tool
 * error result vs. HTTP error class vs. thrown Error) differs per caller.
 */
export function formatResolveFailure(
  agentId: string,
  failure: ResolveAcpAgentFailure,
): string {
  switch (failure.reason) {
    case "unknown_agent":
      return `Unknown agent "${agentId}". Available: ${failure.available.join(", ")}.`;
    case "binary_not_found":
      return `${failure.command} is not on PATH. ${failure.hint}`;
    default: {
      const _exhaustive: never = failure;
      throw new Error(
        `Unexpected acp resolver reason: ${(_exhaustive as { reason: string }).reason}`,
      );
    }
  }
}

interface AcpAgentEntry {
  id: string;
  command: string;
  description?: string;
  source: AcpAgentSource;
  available: boolean;
  unavailableReason?: string;
  setupHint?: string;
}

function installHintFor(command: string): string {
  const pkg = DEFAULT_AGENT_NPM_PACKAGES[command];
  return pkg
    ? `bun add -g ${pkg}`
    : `Install '${command}' and ensure it is on PATH.`;
}

/**
 * Resolve a binary using the same PATH the spawn will see. `AcpAgentProcess`
 * spawns with `{ ...process.env, ...config.env }`, so a per-agent `env.PATH`
 * override wins over the assistant's PATH. Mirror that here so a config that
 * relies on a custom PATH to locate the binary doesn't fail preflight.
 */
function whichOnAgentPath(
  agent: AcpAgentConfig,
  command: string,
): string | null {
  const PATH = agent.env?.PATH ?? process.env.PATH;
  return Bun.which(command, PATH != null ? { PATH } : undefined);
}

/**
 * Resolve an agent config to its runnable form, or `null` when its `command`
 * is not on PATH. Resolution is pure preflight: the binary is used directly
 * when present, and otherwise the agent cannot spawn (callers fall back to
 * the sandboxed `bun` global install in `auto-install.ts`, then re-resolve).
 *
 * Crucially, this never fetches or executes anything in the task cwd: a
 * missing binary returns `null` rather than running a package manager from
 * the (untrusted) project directory.
 */
function resolveRunnableAgent(agent: AcpAgentConfig): AcpAgentConfig | null {
  return whichOnAgentPath(agent, agent.command) ? agent : null;
}

/**
 * Natural-name aliases for the bundled agent ids, keyed by normalized form
 * (see `normalizeAgentId`). Resolution sugar only: aliases are consulted as a
 * last-resort fallback in `lookupAgent` and never appear in the
 * `listAcpAgents` catalog.
 */
const AGENT_ID_ALIASES: Record<string, string> = {
  claudecode: "claude",
  codexcli: "codex",
  openaicodex: "codex",
  geminicli: "gemini",
  googlegemini: "gemini",
};

/**
 * Normalize a raw agent id for alias matching: lowercase and strip spaces,
 * underscores, and hyphens so "Claude Code", "claude-code", and
 * "claude_code" all hit the same alias entry.
 */
function normalizeAgentId(id: string): string {
  return id.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * Resolve an id against user config first, then bundled defaults. Returns the
 * resolved entry plus a `source` label so callers can surface "user override
 * vs bundled default" without re-deriving it.
 *
 * When the raw id misses both maps, fall back to `AGENT_ID_ALIASES` so
 * natural names like "claude code" or "Gemini CLI" resolve to the canonical
 * id. The alias is consulted ONLY after both direct lookups miss, so a user
 * config entry literally keyed "claude code" always wins over the alias.
 */
function lookupAgent(
  userAgents: Record<string, AcpAgentConfig>,
  id: string,
): { agent: AcpAgentConfig; source: AcpAgentSource } | undefined {
  const direct = directLookup(userAgents, id);
  if (direct) return direct;
  const canonicalId = AGENT_ID_ALIASES[normalizeAgentId(id)];
  return canonicalId !== undefined
    ? directLookup(userAgents, canonicalId)
    : undefined;
}

function directLookup(
  userAgents: Record<string, AcpAgentConfig>,
  id: string,
): { agent: AcpAgentConfig; source: AcpAgentSource } | undefined {
  const userAgent = userAgents[id];
  if (userAgent) return { agent: userAgent, source: "config" };
  const defaultAgent = DEFAULT_ACP_AGENT_PROFILES[id];
  if (defaultAgent) return { agent: defaultAgent, source: "default" };
  return undefined;
}

/**
 * Defaults first (declaration order), then user-only ids. Deduplicated so a
 * user config that overrides a default doesn't list the id twice.
 */
function mergedAgentIds(userAgents: Record<string, AcpAgentConfig>): string[] {
  return Array.from(
    new Set([
      ...Object.keys(DEFAULT_ACP_AGENT_PROFILES),
      ...Object.keys(userAgents),
    ]),
  );
}

/**
 * Resolve an ACP agent id to its config + binary preflight result.
 *
 * Order of checks:
 * 1. The id must resolve to an agent (user config wins; falls back to defaults).
 * 2. The agent must be runnable: its `command` on PATH (see
 *    `resolveRunnableAgent`).
 *
 * Each failure mode carries an actionable hint so callers can surface a
 * single user-facing message without re-deriving the remediation.
 */
export function resolveAcpAgent(id: string): ResolveAcpAgentResult {
  const config = getConfig();
  const userAgents = config.acp.agents;
  const found = lookupAgent(userAgents, id);
  if (!found) {
    return {
      ok: false,
      reason: "unknown_agent",
      available: mergedAgentIds(userAgents),
    };
  }

  const { agent } = found;
  const runnable = resolveRunnableAgent(agent);
  if (!runnable) {
    return {
      ok: false,
      reason: "binary_not_found",
      hint: installHintFor(agent.command),
      command: agent.command,
    };
  }

  return { ok: true, agent: runnable };
}

/**
 * Catalog of every ACP agent the assistant knows about — bundled defaults
 * plus any user-only entries — with per-entry availability info. Used by the
 * `acp_list_agents` tool to render setup steps when an agent's binary isn't
 * installed yet.
 */
export function listAcpAgents(): {
  agents: AcpAgentEntry[];
} {
  const config = getConfig();
  const userAgents = config.acp.agents;
  const agents: AcpAgentEntry[] = mergedAgentIds(userAgents).map((id) => {
    // Non-null: ids come from `mergedAgentIds` so the lookup always resolves.
    const { agent, source } = lookupAgent(userAgents, id)!;
    // Same binary preflight as `resolveAcpAgent`: available iff the command
    // is on PATH. A missing binary is auto-installed at spawn time, but the
    // catalog reflects what is runnable right now.
    const available = resolveRunnableAgent(agent) !== null;
    const entry: AcpAgentEntry = {
      id,
      command: agent.command,
      description: agent.description,
      source,
      available,
    };
    if (!available) {
      entry.unavailableReason = `'${agent.command}' is not on PATH`;
      entry.setupHint = installHintFor(agent.command);
    }
    return entry;
  });

  return { agents };
}
