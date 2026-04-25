import type { AcpAgentConfig } from "./acp-schema.js";

/**
 * Default ACP agent profiles that ship with the assistant.
 *
 * When `acp.enabled: true` and the user has not provided a config entry for an
 * agent id, the resolver falls back to this map so common agents like `claude`
 * and `codex` Just Work without requiring per-user config.
 *
 * Keyed by agent id. Frozen so accidental runtime mutation throws in strict
 * mode and the readonly type matches actual runtime behavior.
 */
export const DEFAULT_ACP_AGENT_PROFILES: Readonly<
  Record<string, AcpAgentConfig>
> = Object.freeze({
  claude: Object.freeze({
    command: "claude-agent-acp",
    args: [],
    description: "Claude Code (via @agentclientprotocol/claude-agent-acp)",
  }),
  codex: Object.freeze({
    command: "codex-acp",
    args: [],
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
