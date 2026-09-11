import type { AcpAgentConfig } from "./acp-schema.js";

/**
 * A bundled profile always names its command; a user entry for the same id
 * may omit `command` and inherit this one.
 */
export type AcpAgentProfile = AcpAgentConfig & { command: string };

// Shared frozen empty args array — these defaults are read by every ACP spawn,
// so a single accidental `args.push(...)` from one caller would corrupt every
// subsequent read. Cast through `unknown` because `AcpAgentConfig.args` is
// `string[]` (Zod-inferred) but the value is genuinely immutable at runtime.
const FROZEN_EMPTY_ARGS = Object.freeze([] as string[]) as unknown as string[];

/**
 * Default ACP agent profiles that ship with the assistant.
 *
 * When the user has not provided a config entry for an agent id, the resolver
 * falls back to this map so common agents like `claude` and `codex` Just Work
 * without requiring per-user config.
 *
 * A profile's `model` is the model a session of that agent starts on when the
 * ask names none, and is the rung `acp.agents.<id>.model` fills: a user config
 * entry that names a model overrides it, one that omits it inherits it.
 *
 * Keyed by agent id. Deeply frozen: the outer object, each profile, and the
 * `args` arrays, so mutation throws in strict mode rather than silently
 * corrupting the shared defaults.
 */
export const DEFAULT_ACP_AGENT_PROFILES: Readonly<
  Record<string, AcpAgentProfile>
> = Object.freeze({
  claude: Object.freeze({
    command: "claude-agent-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "Claude Code (via @agentclientprotocol/claude-agent-acp)",
    model: "opus",
  }),
  codex: Object.freeze({
    command: "codex-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "OpenAI Codex CLI (via @agentclientprotocol/codex-acp)",
  }),
});

/**
 * Single source of truth for adapter binary → npm package spec. Automatic
 * installation and the resolver's install hints use this map, so a new
 * adapter only needs one entry here.
 *
 * Keyed by command name (not agent id) so the mapping follows the binary
 * regardless of how a user's config aliases an agent.
 *
 * Values carry an exact version, so a clean install lands the adapter version
 * the daemon was tested against instead of whatever npm calls latest today.
 * An adapter already on PATH is left alone: installation runs only when
 * preflight found no binary at all, so this never moves a version the user
 * installed themselves.
 */
export const DEFAULT_AGENT_NPM_PACKAGES: Readonly<Record<string, string>> =
  Object.freeze({
    "claude-agent-acp": "@agentclientprotocol/claude-agent-acp@0.75.1",
    "codex-acp": "@agentclientprotocol/codex-acp@1.10.0",
  });
