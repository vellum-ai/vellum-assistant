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
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  classifyAnthropicToken,
} from "./acp-credentials.js";
import type { AcpAgentConfig } from "./types.js";

const log = getLogger("acp:prepare-agent-env");

const ACP_SPAWN_TOOL = "acp_spawn";

/**
 * Stable, machine-readable marker carried on the `FailedDependencyError.details`
 * when a `claude-agent-acp` spawn is missing `CLAUDE_CODE_OAUTH_TOKEN`. Threaded
 * through the tool result / error payload as a structured field so clients can
 * offer the inline "Connect Claude Code" flow instead of re-parsing the human
 * message string. Kept in lockstep with the web literal in
 * `clients/web/src/domains/chat/transcript/acp-connect-affordance.tsx`.
 */
export const ACP_CLAUDE_OAUTH_MISSING_CODE = "acp_claude_oauth_missing";

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
 * Force-grant the `acp_spawn` read policy on `acp/<field>`, unioning it into any
 * existing `allowedTools`. Unlike {@link ensureAcpCredentialPolicy} (which
 * PRESERVES an explicit non-empty policy so a passive spawn can't silently widen
 * it), this is for the EXPLICIT Connect flow: a user connecting Claude is a
 * deliberate opt-in to `acp_spawn`, so granting it makes the CTA actually repair
 * a policy-denied credential instead of dead-looping the missing-token card.
 */
export function grantAcpSpawnPolicy(
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
  if (!tools.includes(ACP_SPAWN_TOOL)) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [...tools, ACP_SPAWN_TOOL],
    });
  }
}

/**
 * Whether the `acp_spawn` broker read for `acp/<field>` would actually be
 * permitted, mirroring {@link ensureAcpCredentialPolicy}'s grant rules: a
 * missing or empty `allowedTools` is auto-granted `acp_spawn` at spawn time, so
 * it can read; a non-empty explicit policy is respected as-is, so it can read
 * only when it lists `acp_spawn`. Lets a connected-status check avoid reporting
 * "connected" for a token the spawn is policy-denied from reading (which would
 * otherwise hide the repair CTA and trap the user in a missing-token loop).
 */
export function acpSpawnCanReadCredential(field: string): boolean {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  if (!meta) {
    return true;
  }
  const tools = meta.allowedTools ?? [];
  return tools.length === 0 || tools.includes(ACP_SPAWN_TOOL);
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
 *   2. Secure store via CLI: `assistant credentials prompt --service acp \
 *        --field claude_oauth_token --label ...` — read through the
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
    // A config `env` override or a legacy vault entry can hold an Anthropic API
    // key (`sk-ant-api…`) in this OAuth-only field (e.g. written before the
    // write-path format guard). The adapter would take it as an OAuth token and
    // 401 at runtime, so treat any `api_key` value as absent. Drop it BEFORE the
    // vault read — otherwise a stale API-key override skips the read and shadows
    // the freshly-stored OAuth token, re-looping the Connect card on every
    // auto-continue — and again AFTER the read (the vault value itself can be a
    // legacy key), so the missing-token branch raises the
    // `acp_claude_oauth_missing` marker instead of spawning a doomed credential.
    const dropApiKeyOauthToken = () => {
      if (
        env.CLAUDE_CODE_OAUTH_TOKEN &&
        classifyAnthropicToken(env.CLAUDE_CODE_OAUTH_TOKEN) === "api_key"
      ) {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    };

    dropApiKeyOauthToken();
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      await injectCredential(
        env,
        ACP_OAUTH_TOKEN_FIELD,
        "CLAUDE_CODE_OAUTH_TOKEN",
        "Claude OAuth token for ACP agent authentication",
      );
    }
    dropApiKeyOauthToken();
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      // Carry the stable marker as structured `details` so the client renders
      // the inline "Connect Claude Code" card. The message itself is the tool
      // result the model reads at the failure moment, so it directs the model
      // AT that card and away from CLI/token-paste workarounds — otherwise the
      // model relays a `claude setup-token` / paste-a-token flow that the card
      // exists to replace. The CLI command stays only as a headless fallback.
      throw new FailedDependencyError(
        "claude-agent-acp needs a Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN), " +
          'which is not set. The app shows the user an inline "Connect Claude ' +
          'Code" card. Reply with ONE short sentence: ask them to click Connect ' +
          "in that card to sign in, and tell them you'll continue automatically " +
          "once they're connected. Do NOT say where the card is — never say " +
          '"below", "above", "at the bottom", or "here"; its placement is a UI ' +
          'detail you cannot see. Do NOT say the card "appeared", narrate how ' +
          'the sign-in works, or claim there is "nothing to paste" (the cloud ' +
          "flow does paste a key). Do NOT tell them to run `claude setup-token`, " +
          "paste a token in chat, or run credential CLI commands, and do NOT " +
          "retry the spawn yourself — the card and auto-continue handle it. " +
          "(Headless only, where no card can appear: `assistant credentials prompt " +
          '--service acp --field claude_oauth_token --label "Claude Code OAuth ' +
          'Token"` — it collects the token securely, falling back to a one-time ' +
          "collection link to relay to the user.)",
        { code: ACP_CLAUDE_OAUTH_MISSING_CODE },
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
