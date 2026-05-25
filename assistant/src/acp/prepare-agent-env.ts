/**
 * Inject required env vars for an ACP agent and preflight that they're set.
 *
 * Called by every code path that hands an `AcpAgentConfig` to
 * `AcpSessionManager.spawn`. There are TWO such paths today — the HTTP
 * route `/v1/acp/spawn` (`runtime/routes/acp-routes.ts:spawnSession`) and
 * the skill tool `acp_spawn` (`tools/acp/spawn.ts:executeAcpSpawn`) — and
 * before this helper existed the env-injection logic lived inline in the
 * route only. The skill-tool path bypassed it entirely, so spawns landed
 * with no `CLAUDE_CODE_OAUTH_TOKEN`, the SDK rejected the first prompt
 * with "Authentication required", and the subprocess died as a zombie
 * with no completion notification.
 *
 * The fix: have this single helper own injection + preflight, and have
 * every caller route through it before calling `manager.spawn`.
 */

import { basename } from "node:path";

import { FailedDependencyError } from "../runtime/routes/errors.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import type { AcpAgentConfig } from "./types.js";

/**
 * Returns a NEW config with any required credentials merged into `env`.
 * Does NOT mutate the input. Throws `FailedDependencyError` if a required
 * credential is missing from both the user-supplied env override and the
 * secure store.
 *
 * Gating is keyed off the resolved agent COMMAND (basename), not the
 * user-facing agent id, so a custom `acp.agents.my-claude = { command:
 * "claude-agent-acp", ... }` alias still gets the env it needs.
 *
 * For `claude-agent-acp` the only required env var is
 * `CLAUDE_CODE_OAUTH_TOKEN`. Two provisioning routes converge on it, with
 * config.json winning over the vault so explicit user overrides
 * (per-workspace, rotated, etc.) are never silently clobbered:
 *   1. `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` in `config.json` —
 *      the user-supplied env override on the resolved agent config.
 *   2. Secure store via CLI: `assistant credentials set --service acp \
 *        --field claude_oauth_token <token>` — written to the canonical
 *      `credential/{service}/{field}` key built by `credentialKey()`,
 *      used as fallback when (1) is unset.
 * After resolution, this asserts the token is present (from either route)
 * before spawning. The "fail-fast" throw is symmetric with the existing
 * `binary_not_found` preflight in `resolveAcpAgent` and strictly better
 * than a `warn` + zombie subprocess 10 seconds later.
 */
export async function prepareAgentEnv(
  agentConfig: AcpAgentConfig,
): Promise<AcpAgentConfig> {
  // Clone caller's config + env so we never mutate the resolver's cached
  // agent reference. The local `env` binding sidesteps TS narrowing
  // limitations on the optional `AcpAgentConfig.env` field.
  const env: Record<string, string> = { ...(agentConfig.env ?? {}) };
  const commandBasename = basename(agentConfig.command);

  if (commandBasename === "claude-agent-acp") {
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      const claudeToken = await getSecureKeyAsync(
        credentialKey("acp", "claude_oauth_token"),
      );
      if (claudeToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = claudeToken;
      }
    }
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new FailedDependencyError(
        "claude-agent-acp requires CLAUDE_CODE_OAUTH_TOKEN. " +
          "Run: assistant credentials set --service acp --field claude_oauth_token <token> " +
          "(or set it under acp.agents.<id>.env in config.json).",
      );
    }
  }

  return { ...agentConfig, env };
}
