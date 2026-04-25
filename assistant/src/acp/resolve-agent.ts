/**
 * Shared resolver for ACP agent ids → agent config + binary preflight.
 *
 * `resolveAcpAgent(id)` merges user-provided `config.acp.agents[id]` (wins on
 * overlap) with the bundled `DEFAULT_ACP_AGENT_PROFILES` so common agents like
 * `claude` and `codex` Just Work whenever `acp.enabled: true` — no per-user
 * config required. The result is a discriminated union covering every reason
 * a spawn might fail before we even start the agent process: ACP disabled,
 * unknown agent id, or binary missing from PATH. Callers (acp_spawn,
 * acp_list_agents, and the `/v1/acp/spawn` HTTP route) get a single source
 * of truth and matching actionable hints.
 *
 * `listAcpAgents()` exposes the merged catalog with availability info for
 * the `acp_list_agents` tool — same merge semantics, plus per-entry
 * `available` / `setupHint` derived from `Bun.which` + `DEFAULT_AGENT_NPM_PACKAGES`.
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
export type AcpAgentSource = "config" | "default";

export type ResolveAcpAgentResult =
  | { ok: true; agent: AcpAgentConfig }
  | { ok: false; reason: "acp_disabled"; hint: string }
  | { ok: false; reason: "unknown_agent"; available: string[] }
  | {
      ok: false;
      reason: "binary_not_found";
      hint: string;
      command: string;
    };

export interface AcpAgentEntry {
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
  "Set 'acp.enabled': true in ~/.vellum/workspace/config.json (or via the runtime config endpoint).";

function installHintFor(command: string): string {
  const pkg = DEFAULT_AGENT_NPM_PACKAGES[command];
  return pkg
    ? `npm i -g ${pkg}`
    : `Install '${command}' and ensure it is on PATH.`;
}

/**
 * Resolve an id against user config first, then bundled defaults. Returns the
 * resolved entry plus a `source` label so callers can surface "user override
 * vs bundled default" without re-deriving it.
 */
function lookupAgent(
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
 * 1. ACP must be enabled in config.
 * 2. The id must resolve to an agent (user config wins; falls back to defaults).
 * 3. The agent's `command` must be discoverable via `Bun.which` (PATH lookup).
 *
 * Each failure mode carries an actionable hint so callers can surface a
 * single user-facing message without re-deriving the remediation.
 */
export function resolveAcpAgent(id: string): ResolveAcpAgentResult {
  const config = getConfig();
  if (!config.acp.enabled) {
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
  if (!Bun.which(agent.command)) {
    return {
      ok: false,
      reason: "binary_not_found",
      hint: installHintFor(agent.command),
      command: agent.command,
    };
  }

  return { ok: true, agent };
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
  if (!config.acp.enabled) {
    return { enabled: false, agents: [] };
  }

  const userAgents = config.acp.agents;
  const agents: AcpAgentEntry[] = mergedAgentIds(userAgents).map((id) => {
    // Non-null: ids come from `mergedAgentIds` so the lookup always resolves.
    const { agent, source } = lookupAgent(userAgents, id)!;
    const available = Bun.which(agent.command) !== null;
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
