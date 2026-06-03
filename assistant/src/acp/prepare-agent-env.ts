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
 * Ensure an `acp/<field>` credential has metadata that allows the
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
 * Resolve a broker-stored `acp/<field>` credential into `env[envVar]` unless
 * the caller already supplied it via `agent.env`. Mirrors the OAuth-token
 * resolution: seed the read policy, then read through the broker (which only
 * runs `execute` on a successful, policy-allowed read). config.json overrides
 * always win, so we never clobber an explicit user-supplied value.
 */
async function resolveAcpCredential(
  env: Record<string, string>,
  envVar: string,
  field: string,
  usageDescription: string,
): Promise<void> {
  if (env[envVar]) return;
  ensureAcpTokenPolicy(field, usageDescription);
  await credentialBroker.serverUse<void>({
    service: "acp",
    field,
    toolName: ACP_SPAWN_TOOL,
    execute: async (value) => {
      env[envVar] = value;
    },
  });
}

/**
 * Resolve an LLM credential into `env` honoring the documented precedence:
 *
 *   agent.env explicit  →  vault (broker)  →  ambient process.env
 *
 * The two LLM credentials are mutually exclusive at the adapter level — when
 * both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are set the adapter
 * prefers OAuth — so we must NOT inject a competing credential over one the
 * caller intentionally supplied. Precedence is therefore evaluated as a whole:
 *
 *   1. If `agent.env` already carries EITHER LLM credential, it is the
 *      highest-precedence source. Leave it untouched and inject nothing else
 *      (no vault/ambient OAuth over an explicit API key, and vice versa).
 *   2. Otherwise prefer the vault OAuth token, then the vault API key.
 *   3. Otherwise fall back to the ambient `process.env` OAuth token, then the
 *      ambient API key. This preserves local users who export a daemon-level
 *      `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`: sibling PR F1 strips
 *      the daemon's ambient env from the spawned agent, so the only way an
 *      ambient cred reaches the adapter is for us to read it here and inject
 *      it via the returned `config.env` (which survives the F1 strip).
 */
async function resolveLlmCredential(
  env: Record<string, string>,
): Promise<void> {
  // (1) Explicit agent.env credential wins outright — never compete with it.
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return;

  // (2) Vault: prefer the OAuth token, fall back to an Anthropic API key.
  await resolveAcpCredential(
    env,
    "CLAUDE_CODE_OAUTH_TOKEN",
    "claude_oauth_token",
    "Claude OAuth token for ACP agent authentication",
  );
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    await resolveAcpCredential(
      env,
      "ANTHROPIC_API_KEY",
      "anthropic_api_key",
      "Anthropic API key for ACP agent authentication",
    );
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return;

  // (3) Ambient process.env: same OAuth-preferred ordering. Injected into the
  // returned env so it survives F1's spawn-env strip.
  const ambientOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (ambientOAuth) {
    env.CLAUDE_CODE_OAUTH_TOKEN = ambientOAuth;
    return;
  }
  const ambientApiKey = process.env.ANTHROPIC_API_KEY;
  if (ambientApiKey) {
    env.ANTHROPIC_API_KEY = ambientApiKey;
  }
}

/**
 * Returns a NEW config with any required credentials merged into `env`.
 * Does NOT mutate the input. Throws `FailedDependencyError` if a required
 * credential is missing from the user-supplied env override, the secure
 * store, AND the ambient process env.
 *
 * Gating is keyed off the resolved agent COMMAND (basename), not the
 * user-facing agent id, so a custom `acp.agents.my-claude = { command:
 * "claude-agent-acp", ... }` alias still gets the env it needs.
 *
 * For `claude-agent-acp` the agent needs ONE of two LLM credentials, plus
 * an optional git/dev credential so it can clone/push.
 *   1. LLM auth — `CLAUDE_CODE_OAUTH_TOKEN` (preferred) OR `ANTHROPIC_API_KEY`,
 *      resolved by precedence: explicit `acp.agents.<id>.env` in `config.json`
 *      wins, then the secure store (`acp/claude_oauth_token` /
 *      `acp/anthropic_api_key`) read through the credential broker, then the
 *      ambient `process.env`. Once a source supplies a credential we never
 *      inject a competing one over it (the adapter prefers OAuth when both are
 *      set, so an explicit API key must not be shadowed by a vault/ambient
 *      OAuth token — and vice versa).
 *   2. Git auth (optional) — `GH_TOKEN` from `acp.agents.<id>.env` or the
 *      secure store (`acp/git_token`). Injected when present; never required.
 * After resolution, this asserts at least one LLM credential is present
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
    // LLM auth: agent.env explicit → vault → ambient process.env.
    await resolveLlmCredential(env);
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
      throw new FailedDependencyError(
        "claude-agent-acp requires an LLM credential: either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. " +
          "Run: assistant credentials set --service acp --field claude_oauth_token <token> " +
          "(or --field anthropic_api_key <key>), or set it under acp.agents.<id>.env in config.json.",
      );
    }

    // Git auth (optional): inject when present so the agent can clone/push.
    await resolveAcpCredential(
      env,
      "GH_TOKEN",
      "git_token",
      "Git token for ACP agent clone/push",
    );
  }

  return { ...agentConfig, env };
}
