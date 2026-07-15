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
import { getLogger } from "../util/logger.js";
import type { AcpAgentConfig } from "./types.js";

const log = getLogger("acp:prepare-agent-env");

const ACP_SPAWN_TOOL = "acp_spawn";
const ACP_SERVICE = "acp";

/**
 * Ensure an `acp/<field>` credential has metadata that allows the
 * `acp_spawn` tool to read it, but only for legacy/unmanaged cases:
 *
 * - No metadata at all: create with `allowedTools: ["acp_spawn"]`.
 * - Metadata exists with an empty `allowedTools`: default provisioning
 *   path (user ran `credentials set` without `--allowed-tools`), add it.
 * - Metadata exists with a non-empty `allowedTools`: explicit policy set
 *   by the user/admin. Respect it even if `acp_spawn` is absent; the
 *   broker will deny the read and the caller decides whether that's fatal.
 */
export function ensureAcpCredentialPolicy(
  field: string,
  usageDescription: string,
): void {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  if (!meta) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [ACP_SPAWN_TOOL],
      usageDescription,
    });
    return;
  }
  const tools = meta.allowedTools ?? [];
  if (tools.length === 0) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [ACP_SPAWN_TOOL],
    });
  }
}

/**
 * Read an `acp/<field>` credential through the broker and inject it into
 * `env` under `envVar`. Returns the broker's failure reason when the value
 * was not injected (missing credential, denied policy, no stored value),
 * or undefined on success. Never throws: `serverUse` signals every failure
 * mode, including a simply-absent credential, as `{ success: false,
 * reason }`, so callers choose whether a miss is fatal.
 */
async function injectCredential(
  env: Record<string, string>,
  field: string,
  envVar: string,
  usageDescription: string,
): Promise<string | undefined> {
  ensureAcpCredentialPolicy(field, usageDescription);
  const result = await credentialBroker.serverUse<void>({
    service: ACP_SERVICE,
    field,
    toolName: ACP_SPAWN_TOOL,
    execute: async (value) => {
      env[envVar] = value;
    },
  });
  return result.success ? undefined : result.reason;
}

/**
 * Inject an OPTIONAL credential: skip when the env var is already set
 * (config.json override wins), and treat a vault miss as non-fatal — the
 * adapter has its own login fallback, so spawning without the key is fine.
 */
async function injectOptionalCredential(
  env: Record<string, string>,
  field: string,
  envVar: string,
  usageDescription: string,
): Promise<void> {
  if (env[envVar]) return;
  const missReason = await injectCredential(
    env,
    field,
    envVar,
    usageDescription,
  );
  if (missReason !== undefined) {
    log.debug(
      { reason: missReason },
      `${envVar} unavailable from the vault; spawning without it`,
    );
  }
}

/**
 * Returns a NEW config with any required credentials merged into `env`.
 * Does NOT mutate the input. Throws `FailedDependencyError` if a required
 * credential is missing from both the user-supplied env override and the
 * secure store.
 *
 * Gating is keyed off the resolved command basename, not the user-facing
 * agent id. A custom `acp.agents.my-claude = { command: "claude-agent-acp",
 * ... }` alias (or a full path like `/opt/bin/claude-agent-acp`) still gets
 * the env it needs. Because resolution always yields the real adapter binary
 * (never a `bun x` wrapper), the basename is the canonical adapter identity.
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
 * For `codex-acp` the env vars are `OPENAI_API_KEY` (vault field
 * `acp/openai_api_key`) and `CODEX_API_KEY` (vault field
 * `acp/codex_api_key`), provisioned the same two ways (config.json
 * override wins, vault second). Both are OPTIONAL: codex also supports
 * ChatGPT login (`codex login` pre-seeding `auth.json` in the workspace),
 * so a vault miss proceeds without the key instead of failing the spawn.
 */
export async function prepareAgentEnv(
  agentConfig: AcpAgentConfig,
): Promise<AcpAgentConfig> {
  // Clone caller's config + env so we never mutate the resolver's cached
  // agent reference. The local `env` binding sidesteps TS narrowing
  // limitations on the optional `AcpAgentConfig.env` field.
  const env: Record<string, string> = { ...(agentConfig.env ?? {}) };
  const adapterCommand = basename(agentConfig.command);

  if (adapterCommand === "claude-agent-acp") {
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      await injectCredential(
        env,
        "claude_oauth_token",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "Claude OAuth token for ACP agent authentication",
      );
    }
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new FailedDependencyError(
        "claude-agent-acp requires CLAUDE_CODE_OAUTH_TOKEN. " +
          "Run: assistant credentials set --service acp --field claude_oauth_token <token> " +
          "(or set it under acp.agents.<id>.env in config.json).",
      );
    }
  } else if (adapterCommand === "codex-acp") {
    // The two reads target independent vault fields and write disjoint env
    // keys, so running them concurrently is safe.
    await Promise.all([
      injectOptionalCredential(
        env,
        "openai_api_key",
        "OPENAI_API_KEY",
        "OpenAI API key for Codex ACP agent authentication",
      ),
      injectOptionalCredential(
        env,
        "codex_api_key",
        "CODEX_API_KEY",
        "Codex API key for Codex ACP agent authentication",
      ),
    ]);
  }

  return { ...agentConfig, env };
}
