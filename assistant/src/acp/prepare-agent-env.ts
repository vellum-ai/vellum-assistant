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
 *
 * Credential reads go through the credential broker (`serverUse`) so they
 * are policy-gated (tool allowlist) and audit-logged. This keeps
 * `prepare-agent-env.ts` off the secure-keys import allowlist — the broker
 * owns the plaintext read boundary.
 */

import { basename } from "node:path";

import { FailedDependencyError } from "../runtime/routes/errors.js";
import { credentialBroker } from "../tools/credentials/broker.js";
import {
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import type { AcpAgentConfig } from "./types.js";

const ACP_SPAWN_TOOL = "acp_spawn";

/**
 * Ensure the `acp/<field>` credential has metadata that allows the
 * `acp_spawn` tool to read it, but only for legacy/unmanaged cases:
 *
 * - No metadata at all → create with `allowedTools: ["acp_spawn"]`.
 * - Metadata exists with an empty `allowedTools` → default provisioning
 *   path (user ran `credentials set` without `--allowed-tools`), add it.
 * - Metadata exists with a non-empty `allowedTools` → explicit policy set
 *   by the user/admin. Respect it even if `acp_spawn` is absent — the
 *   broker will deny the read and the preflight will throw.
 */
function ensureAcpTokenPolicy(field: string, usageDescription: string): void {
  const meta = getCredentialMetadata("acp", field);
  if (!meta) {
    upsertCredentialMetadata("acp", field, {
      allowedTools: [ACP_SPAWN_TOOL],
      usageDescription,
    });
    return;
  }
  const tools = meta.allowedTools ?? [];
  if (tools.length === 0) {
    upsertCredentialMetadata("acp", field, {
      allowedTools: [ACP_SPAWN_TOOL],
    });
  }
}

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
 *        --field claude_oauth_token <token>` — read through the
 *      credential broker for policy enforcement and audit logging.
 * After resolution, this asserts the token is present (from either route)
 * before spawning. The "fail-fast" throw is symmetric with the existing
 * `binary_not_found` preflight in `resolveAcpAgent` and strictly better
 * than a `warn` + zombie subprocess 10 seconds later.
 *
 * For `codex-acp` the same two-route resolution applies to the user's
 * OpenAI/Codex API key, injected as both `OPENAI_API_KEY` and
 * `CODEX_API_KEY` (the codex CLI accepts either). The config.json override
 * may set either var; an override under one satisfies the requirement and
 * the vault is not consulted. The vault field is `acp/openai_api_key`.
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
      ensureAcpTokenPolicy(
        "claude_oauth_token",
        "Claude OAuth token for ACP agent authentication",
      );
      await credentialBroker.serverUse<void>({
        service: "acp",
        field: "claude_oauth_token",
        toolName: ACP_SPAWN_TOOL,
        execute: async (token) => {
          env.CLAUDE_CODE_OAUTH_TOKEN = token;
        },
      });
    }
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new FailedDependencyError(
        "claude-agent-acp requires CLAUDE_CODE_OAUTH_TOKEN. " +
          "Run: assistant credentials set --service acp --field claude_oauth_token <token> " +
          "(or set it under acp.agents.<id>.env in config.json).",
      );
    }
  }

  if (commandBasename === "codex-acp") {
    // The codex-acp adapter shells out to the `codex` CLI, which accepts the
    // user's OpenAI/Codex API key via either CODEX_API_KEY or OPENAI_API_KEY.
    // A config.json env override (under either var) wins over the vault, so
    // explicit per-workspace/rotated keys are never silently clobbered.
    if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
      ensureAcpTokenPolicy(
        "openai_api_key",
        "OpenAI/Codex API key for codex-acp agent authentication",
      );
      await credentialBroker.serverUse<void>({
        service: "acp",
        field: "openai_api_key",
        toolName: ACP_SPAWN_TOOL,
        execute: async (key) => {
          env.OPENAI_API_KEY = key;
          env.CODEX_API_KEY = key;
        },
      });
    }
    if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
      throw new FailedDependencyError(
        "codex-acp requires an OpenAI/Codex API key (OPENAI_API_KEY or CODEX_API_KEY). " +
          "Run: assistant credentials set --service acp --field openai_api_key <key> " +
          "(or set it under acp.agents.<id>.env in config.json).",
      );
    }
  }

  return { ...agentConfig, env };
}
