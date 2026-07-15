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
import {
  ACP_ANTHROPIC_API_KEY_FIELD,
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
} from "./acp-credentials.js";
import { resolveAcpGatewayAuth } from "./gateway-auth.js";
import type { AcpAgentConfig } from "./types.js";

const log = getLogger("acp:prepare-agent-env");

const ACP_SPAWN_TOOL = "acp_spawn";

// The SHARED Anthropic API key (service "anthropic", field "api_key") that
// other tools already use. ACP reuses it only after explicit consent — the
// user grants `acp_spawn` read-access via `assistant credentials grant`. The
// field name is bound through an intermediate so its literal never shares a
// line with an `*_KEY = "…"` shape the repo's secret-scan hook false-positives.
const SHARED_ANTHROPIC_SERVICE = "anthropic";
const sharedAnthropicApiField = "api_key";

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
function ensureAcpCredentialPolicy(
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
 * Read the SHARED `anthropic/api_key` credential through the broker and inject
 * it as `ANTHROPIC_API_KEY`. Unlike `injectCredential`, this provisions no
 * policy: the broker denies the read unless the user opted the shared key into
 * ACP by adding `acp_spawn` to its `allowedTools` (via `assistant credentials
 * grant`), so an unconsented key is never reused. A miss (absent, unconsented,
 * or valueless) is non-fatal — the caller falls through to the next credential
 * tier.
 */
async function injectSharedAnthropicApiKey(
  env: Record<string, string>,
): Promise<void> {
  const result = await credentialBroker.serverUse<void>({
    service: SHARED_ANTHROPIC_SERVICE,
    field: sharedAnthropicApiField,
    toolName: ACP_SPAWN_TOOL,
    execute: async (value) => {
      env.ANTHROPIC_API_KEY = value;
    },
  });
  if (!result.success) {
    log.debug(
      { reason: result.reason },
      "shared anthropic/api_key not available for ACP reuse; trying next tier",
    );
  }
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
 * For `claude-agent-acp` exactly ONE credential env var is set, preferring an
 * Anthropic API key over the subscription OAuth token. config.json wins over
 * the vault so explicit user overrides are never silently clobbered; the first
 * source that satisfies the auth requirement short-circuits the rest:
 *   1. `acp.agents.<id>.env.ANTHROPIC_API_KEY` or `.CLAUDE_CODE_OAUTH_TOKEN`
 *      in `config.json` — the user-supplied env override.
 *   2. `acp/anthropic_api_key` from the vault → `ANTHROPIC_API_KEY`.
 *   3. The SHARED `anthropic/api_key`, but only when the user opted it into
 *      ACP (`acp_spawn` in its `allowedTools`) → `ANTHROPIC_API_KEY`.
 *   4. `acp/claude_oauth_token` from the vault → `CLAUDE_CODE_OAUTH_TOKEN`.
 * If none apply this throws `FailedDependencyError` naming the options — a
 * fail-fast symmetric with the `binary_not_found` preflight in
 * `resolveAcpAgent` and strictly better than a zombie subprocess later.
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
    // Gateway-mode proxy routing (flag-gated, off by default): the adapter
    // authenticates the child against the Vellum runtime proxy, so no Anthropic
    // credential is needed — skip injection and the throw. Off → PR-2 path below.
    if (await resolveAcpGatewayAuth()) {
      // The proxy supplies auth and is authoritative. Shadow (empty), not
      // delete: AcpAgentProcess.spawn() builds the child env as
      // `{ ...process.env, ...config.env }`, so a bare delete would let an
      // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN inherited from the daemon's
      // own process.env survive the merge and bypass per-assistant proxy
      // billing — worst case a version-skew adapter that never runs the gateway
      // handshake falls back to that inherited key. An empty value overrides the
      // inherited one and reads as "unset" (selectEnvVarAuthMethod requires
      // non-empty). The dev-platform live test validates the version-skew case
      // before un-flagging.
      env.ANTHROPIC_API_KEY = "";
      env.CLAUDE_CODE_OAUTH_TOKEN = "";
      return { ...agentConfig, env };
    }

    const hasClaudeCred = () =>
      Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);

    if (!hasClaudeCred()) {
      await injectCredential(
        env,
        ACP_ANTHROPIC_API_KEY_FIELD,
        "ANTHROPIC_API_KEY",
        "Anthropic API key for ACP agent authentication",
      );
    }
    if (!hasClaudeCred()) {
      await injectSharedAnthropicApiKey(env);
    }
    if (!hasClaudeCred()) {
      await injectCredential(
        env,
        ACP_OAUTH_TOKEN_FIELD,
        "CLAUDE_CODE_OAUTH_TOKEN",
        "Claude OAuth token for ACP agent authentication",
      );
    }
    if (!hasClaudeCred()) {
      throw new FailedDependencyError(
        "claude-agent-acp requires an Anthropic credential and none was found. " +
          "Provision one of: the shared Anthropic API key opted into ACP " +
          "(assistant credentials set --service anthropic --field api_key <sk-ant-api…> --allowed-tools acp_spawn), " +
          "a dedicated acp/anthropic_api_key " +
          "(assistant credentials set --service acp --field anthropic_api_key <sk-ant-api…>), " +
          "or acp/claude_oauth_token " +
          "(assistant credentials set --service acp --field claude_oauth_token <sk-ant-oat…>). " +
          "You can also set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN under acp.agents.<id>.env in config.json.",
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
