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
 * Install hints for ACP adapter binaries, keyed by command name (not agent id).
 *
 * Keying by command name lets the resolver and `acp_list_agents` reuse this
 * map regardless of how a user's config aliases an agent — the install hint
 * follows the binary, not the alias.
 */
export const DEFAULT_AGENT_INSTALL_HINTS: Readonly<Record<string, string>> =
  Object.freeze({
    "claude-agent-acp": "npm i -g @agentclientprotocol/claude-agent-acp",
    "codex-acp": "npm i -g @zed-industries/codex-acp",
  });
