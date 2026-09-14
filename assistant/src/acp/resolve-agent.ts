/**
 * Shared resolver for ACP agent ids → agent config + binary preflight.
 *
 * `resolveAcpAgent(id)` layers user-provided `config.acp.agents[id]` over the
 * bundled `DEFAULT_ACP_AGENT_PROFILES` so common agents like `claude` and
 * `codex` Just Work with no per-user config required; `mergeWithProfile` says
 * what an entry inherits. Natural names ("claude code", "OpenAI Codex")
 * resolve via `AGENT_ID_ALIASES` when the raw id misses both maps. The result
 * is a discriminated union covering every reason a spawn might fail before we
 * even start the agent process: unknown agent id, or binary missing from
 * PATH. Callers (acp_spawn, acp_list_agents, and the `/v1/acp/spawn` HTTP
 * route) get a single source of truth and matching actionable hints.
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

import { basename } from "node:path";

import {
  type AcpAgentProfile,
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_NPM_PACKAGES,
} from "../config/acp-defaults.js";
import type { AcpAgentConfig as ConfiguredAcpAgent } from "../config/acp-schema.js";
import { getConfig } from "../config/loader.js";
import type { AcpAgentConfig } from "./types.js";

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
};

/**
 * Ids that read back as inherited `Object.prototype` members instead of
 * configured agents. `directLookup` and `mergedAgentIds` refuse them so an id
 * from a tool call or an HTTP body can resolve to nothing but a real entry:
 * resolving one would report a configured agent that does not exist, and a
 * spawn would then start a process for a config nobody wrote.
 */
const PROTOTYPE_SENSITIVE_AGENT_IDS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

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
 * natural names like "claude code" or "OpenAI Codex" resolve to the canonical
 * id. The alias is consulted ONLY after both direct lookups miss, so a user
 * config entry literally keyed "claude code" always wins over the alias.
 */
/**
 * The configured agent for an id, without checking that its binary exists.
 *
 * `resolveAcpAgent` answers "can this be run", which a caller that only wants
 * to know which credential the agent would use does not need and cannot always
 * get: a marker outlives the run that wrote it, and the binary may since have
 * gone.
 */
export function lookupAcpAgentConfig(id: string): AcpAgentConfig | undefined {
  return lookupAgent(getConfig().acp.agents, id)?.agent;
}

function lookupAgent(
  userAgents: Record<string, ConfiguredAcpAgent>,
  id: string,
): { agent: AcpAgentConfig; source: AcpAgentSource; id: string } | undefined {
  const direct = directLookup(userAgents, id);
  if (direct) {
    return { ...direct, id };
  }
  const normalized = normalizeAgentId(id);
  const canonicalId = Object.hasOwn(AGENT_ID_ALIASES, normalized)
    ? AGENT_ID_ALIASES[normalized]
    : undefined;
  if (canonicalId === undefined) {
    return undefined;
  }
  const aliased = directLookup(userAgents, canonicalId);
  return aliased ? { ...aliased, id: canonicalId } : undefined;
}

function directLookup(
  userAgents: Record<string, ConfiguredAcpAgent>,
  id: string,
): { agent: AcpAgentConfig; source: AcpAgentSource } | undefined {
  if (PROTOTYPE_SENSITIVE_AGENT_IDS.has(id)) {
    return undefined;
  }
  const userAgent = Object.hasOwn(userAgents, id) ? userAgents[id] : undefined;
  const defaultAgent = Object.hasOwn(DEFAULT_ACP_AGENT_PROFILES, id)
    ? DEFAULT_ACP_AGENT_PROFILES[id]
    : undefined;
  if (userAgent) {
    const agent = mergeWithProfile(userAgent, defaultAgent);
    return agent ? { agent, source: "config" } : undefined;
  }
  if (defaultAgent) {
    return { agent: defaultAgent, source: "default" };
  }
  return undefined;
}

/**
 * Fill a user config entry from the bundled profile for the same id. An entry
 * that runs the profile's adapter (it omits `command`, or names the same
 * binary, by full path or not) inherits the leaves it leaves out: `command`
 * itself, the description, and the `model` a session starts on. `args` is the
 * exception, because the schema defaults it to `[]`: a parsed entry always
 * carries its own, so the profile's never reaches it. An entry that points
 * the id at a different adapter stands alone, like any user-only entry,
 * so a config that reuses the `claude` id for something else never carries
 * Claude's description or has Claude's `opus` sent to it. Zod omits absent
 * optional keys, so an omission never spreads as an undefined override.
 *
 * `undefined` only for an entry with neither a command nor a profile to take
 * one from, a shape the config schema rejects before it gets here.
 */
function mergeWithProfile(
  userAgent: ConfiguredAcpAgent,
  profile: AcpAgentProfile | undefined,
): AcpAgentConfig | undefined {
  const command = userAgent.command;
  if (!profile) {
    return command === undefined ? undefined : { ...userAgent, command };
  }
  // A full path to the bundled binary is still the bundled adapter; the
  // basename is the adapter's identity everywhere else in this module.
  if (
    command !== undefined &&
    basename(command) !== basename(profile.command)
  ) {
    return { ...userAgent, command };
  }
  return { ...profile, ...userAgent, command: command ?? profile.command };
}

/**
 * Defaults first (declaration order), then user-only ids. Deduplicated so a
 * user config that overrides a default doesn't list the id twice.
 */
function mergedAgentIds(
  userAgents: Record<string, ConfiguredAcpAgent>,
): string[] {
  return Array.from(
    new Set([
      ...Object.keys(DEFAULT_ACP_AGENT_PROFILES),
      ...Object.keys(userAgents),
    ]),
  ).filter((id) => !PROTOTYPE_SENSITIVE_AGENT_IDS.has(id));
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
    // Non-null: ids come from `mergedAgentIds`, and the schema admits a
    // command-less entry only for a bundled id, so the lookup always resolves.
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
