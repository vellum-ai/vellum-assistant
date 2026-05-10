import type { AcpAgentConfig } from "./acp-schema.js";

// Shared frozen empty args array — these defaults are read by every ACP spawn,
// so a single accidental `args.push(...)` from one caller would corrupt every
// subsequent read. Cast through `unknown` because `AcpAgentConfig.args` is
// `string[]` (Zod-inferred) but the value is genuinely immutable at runtime.
const FROZEN_EMPTY_ARGS = Object.freeze([] as string[]) as unknown as string[];

/**
 * Default ACP agent profiles that ship with the assistant.
 *
 * When `acp.enabled: true` and the user has not provided a config entry for an
 * agent id, the resolver falls back to this map so common agents like `claude`
 * and `codex` Just Work without requiring per-user config.
 *
 * Keyed by agent id. Deeply frozen — the outer object, each profile, and the
 * `args` arrays — so mutation throws in strict mode rather than silently
 * corrupting the shared defaults.
 */
export const DEFAULT_ACP_AGENT_PROFILES: Readonly<
  Record<string, AcpAgentConfig>
> = Object.freeze({
  claude: Object.freeze({
    command: "claude-agent-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "Claude Code (via @agentclientprotocol/claude-agent-acp)",
  }),
  codex: Object.freeze({
    command: "codex-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "OpenAI Codex CLI (via @zed-industries/codex-acp)",
  }),
});

/**
 * Single source of truth for adapter binary → npm package name. Both the
 * version-check probe in `acp_spawn` and the resolver's install-hint format
 * key off this map, so a new adapter only needs one entry here.
 *
 * Keyed by command name (not agent id) so the mapping follows the binary
 * regardless of how a user's config aliases an agent.
 */
export const DEFAULT_AGENT_NPM_PACKAGES: Readonly<Record<string, string>> =
  Object.freeze({
    "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
    "codex-acp": "@zed-industries/codex-acp",
  });
