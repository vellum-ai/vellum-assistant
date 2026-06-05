/**
 * Shared resolver for ACP agent ids → agent config + binary preflight.
 *
 * `resolveAcpAgent(id)` merges user-provided `config.acp.agents[id]` (wins on
 * overlap) with the bundled `DEFAULT_ACP_AGENT_PROFILES` so common agents like
 * `claude` and `codex` Just Work whenever ACP is enabled (the `acp` feature
 * flag or `acp.enabled: true`; see `feature-gate.ts`), with no per-user
 * config required. Natural names ("claude code", "Gemini CLI") resolve via
 * `AGENT_ID_ALIASES` when the raw id misses both maps. The result is a
 * discriminated union covering every reason
 * a spawn might fail before we even start the agent process: ACP disabled,
 * unknown agent id, or binary missing from PATH. Callers (acp_spawn,
 * acp_list_agents, and the `/v1/acp/spawn` HTTP route) get a single source
 * of truth and matching actionable hints.
 *
 * When the adapter binary is NOT on PATH but `bun` is and the command has a
 * vendored entry in `DEFAULT_AGENT_NPM_PACKAGES`, the resolver rewrites the
 * agent to run via `bun x --bun <package>` instead of failing. bunx fetches
 * the package into its cache on first use, so platform-hosted assistants
 * whose image ships bun (but no node and no npm) work out of the box with
 * no global install. The original command is preserved as `adapterCommand`
 * so downstream consumers (env injection, resume hints, version probe) keep
 * gating on the canonical adapter identity.
 *
 * `listAcpAgents()` exposes the merged catalog with availability info for
 * the `acp_list_agents` tool — same merge semantics, plus per-entry
 * `available` / `setupHint` derived from the same binary-or-bunx resolution.
 */

import { basename } from "node:path";

import {
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_NPM_PACKAGES,
} from "../config/acp-defaults.js";
import type { AcpAgentConfig } from "../config/acp-schema.js";
import { getConfig } from "../config/loader.js";
import { isAcpEnabled } from "./feature-gate.js";

/**
 * Whether this agent's entry came from user config (wins over default) or
 * fell back to the bundled default profile. Surfaced in `acp_list_agents`
 * output so users can see at a glance which agents they've customized.
 */
type AcpAgentSource = "config" | "default";

/**
 * A resolver-produced agent config, ready to spawn. `adapterCommand` carries
 * the canonical adapter identity (e.g. "claude-agent-acp") even when the
 * spawn command was rewritten to run via `bun x`, so consumers that gate
 * behavior on the adapter (env injection in `prepare-agent-env.ts`, resume
 * hints, the version probe in `tools/acp/spawn.ts`) stay correct for
 * bunx-resolved agents.
 */
export interface ResolvedAcpAgent extends AcpAgentConfig {
  adapterCommand: string;
}

/**
 * Canonical adapter identity for a (possibly rewritten) agent config.
 * Resolver-produced configs carry `adapterCommand` explicitly; plain configs
 * that never went through the resolver fall back to the command basename so
 * user-supplied agent configs keep working.
 */
export function adapterCommandOf(config: {
  command: string;
  adapterCommand?: string;
}): string {
  return config.adapterCommand ?? basename(config.command);
}

/**
 * Whether the config was rewritten by the resolver to run through `bun x`
 * (the only path where the canonical adapter identity diverges from the
 * actual spawn command).
 */
export function runsViaBunx(config: {
  command: string;
  adapterCommand?: string;
}): boolean {
  return (
    config.adapterCommand !== undefined &&
    config.adapterCommand !== basename(config.command)
  );
}

export type ResolveAcpAgentResult =
  | { ok: true; agent: ResolvedAcpAgent }
  | ResolveAcpAgentFailure;

export type ResolveAcpAgentFailure =
  | { ok: false; reason: "acp_disabled"; hint: string }
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
    case "acp_disabled":
      return failure.hint;
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

/**
 * Single-source-of-truth hint for "ACP is disabled". Exported so any caller
 * that surfaces a disabled-state message (resolver, list-agents tool) reads
 * the same string instead of duplicating near-identical copy.
 */
export const ACP_DISABLED_HINT =
  "Enable the \"ACP Coding Agents\" feature flag in the client's feature flags UI (or set 'acp.enabled': true in ~/.vellum/workspace/config.json).";

function installHintFor(command: string): string {
  const pkg = DEFAULT_AGENT_NPM_PACKAGES[command];
  return pkg
    ? `npm i -g ${pkg}`
    : `Install '${command}' and ensure it is on PATH.`;
}

/**
 * Resolve a binary using the same PATH the spawn will see. `AcpAgentProcess`
 * spawns with `{ ...process.env, ...config.env }`, so a per-agent `env.PATH`
 * override wins over the assistant's PATH. Mirror that here so a config that
 * relies on a custom PATH to locate the binary (or `bun`, for the bunx
 * rewrite) doesn't fail preflight.
 */
function whichOnAgentPath(
  agent: AcpAgentConfig,
  command: string,
): string | null {
  const PATH = agent.env?.PATH ?? process.env.PATH;
  return Bun.which(command, PATH != null ? { PATH } : undefined);
}

/**
 * Resolve an agent config to its runnable form, or `null` when it cannot
 * spawn. The ONLY place the bunx rewrite happens:
 *
 * 1. Binary on PATH → use it directly (`adapterCommand` = command basename).
 * 2. Binary missing, command has a vendored npm package mapping, and `bun`
 *    is on PATH → rewrite to `bun x --bun <package> <original args>`. bunx
 *    fetches the package on first use, preserving the
 *    install-latest-on-first-use design with no global install.
 * 3. Otherwise → null (callers fall back to npm auto-install or surface the
 *    install hint).
 *
 * Security boundary (mirrors `auto-install.ts`): only commands present in
 * `DEFAULT_AGENT_NPM_PACKAGES` are ever rewritten. The package names are
 * vendored constants, NOT user input: an arbitrary command from user config
 * must never be turned into a `bun x <attacker-controlled-name>` execution.
 */
function resolveRunnableAgent(agent: AcpAgentConfig): ResolvedAcpAgent | null {
  if (whichOnAgentPath(agent, agent.command)) {
    return { ...agent, adapterCommand: basename(agent.command) };
  }
  const packageName = DEFAULT_AGENT_NPM_PACKAGES[agent.command];
  if (!packageName || !whichOnAgentPath(agent, "bun")) return null;
  return {
    ...agent,
    command: "bun",
    args: ["x", "--bun", packageName, ...agent.args],
    adapterCommand: agent.command,
  };
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
 * 1. ACP must be enabled (feature flag or config; see `isAcpEnabled`).
 * 2. The id must resolve to an agent (user config wins; falls back to defaults).
 * 3. The agent must be runnable: its `command` on PATH, or the bunx rewrite
 *    applies (see `resolveRunnableAgent`).
 *
 * Each failure mode carries an actionable hint so callers can surface a
 * single user-facing message without re-deriving the remediation.
 */
export function resolveAcpAgent(id: string): ResolveAcpAgentResult {
  const config = getConfig();
  if (!isAcpEnabled(config)) {
    return { ok: false, reason: "acp_disabled", hint: ACP_DISABLED_HINT };
  }

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
 *
 * `enabled: false` short-circuits and returns an empty catalog so the tool
 * can render a single "ACP is disabled" hint instead of advertising agents
 * the user can't actually run.
 */
export function listAcpAgents(): {
  enabled: boolean;
  agents: AcpAgentEntry[];
} {
  const config = getConfig();
  if (!isAcpEnabled(config)) {
    return { enabled: false, agents: [] };
  }

  const userAgents = config.acp.agents;
  const agents: AcpAgentEntry[] = mergedAgentIds(userAgents).map((id) => {
    // Non-null: ids come from `mergedAgentIds` so the lookup always resolves.
    const { agent, source } = lookupAgent(userAgents, id)!;
    // Same binary-or-bunx resolution as `resolveAcpAgent`: an agent whose
    // binary is missing but would spawn via `bun x` IS available.
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

  return { enabled: true, agents };
}
