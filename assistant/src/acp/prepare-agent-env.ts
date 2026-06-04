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

import { getIsPlatform } from "../config/env-registry.js";
import { FailedDependencyError } from "../runtime/routes/errors.js";
import { credentialBroker } from "../tools/credentials/broker.js";
import {
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getLogger } from "../util/logger.js";
import { LINKABLE_FIELD_DESCRIPTIONS } from "./credential-fields.js";
import type { AcpAgentConfig } from "./types.js";

/**
 * Tool name the agent-spawn path presents to the credential broker. The
 * in-pod credential-link route (`runtime/routes/acp-routes.ts`) writes this
 * into each linked credential's `allowedTools` so the broker authorizes the
 * read here. Exported so the two sides can never drift.
 */
export const ACP_SPAWN_TOOL = "acp_spawn";

const log = getLogger("acp:prepare-agent-env");

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
 * Resolve a broker-stored `acp/<field>` credential into one or more env vars
 * unless the caller already supplied any of them via `agent.env`. Mirrors the
 * OAuth-token resolution: seed the read policy, then read through the broker
 * (which only runs `execute` on a successful, policy-allowed read). config.json
 * overrides always win, so we never clobber an explicit user-supplied value.
 *
 * `envVars` is a list so a single vault value can populate every var an adapter
 * accepts — e.g. codex reads its API key from BOTH `OPENAI_API_KEY` and
 * `CODEX_API_KEY`, so one `acp/openai_api_key` read fills both. The usage
 * description seeded into the field's metadata is read from the shared
 * single-source field map so the writer (link route) and this reader agree.
 */
async function resolveAcpCredential(
  env: Record<string, string>,
  envVars: string[],
  field: keyof typeof LINKABLE_FIELD_DESCRIPTIONS,
): Promise<void> {
  if (envVars.some((v) => env[v])) return;
  ensureAcpTokenPolicy(field, LINKABLE_FIELD_DESCRIPTIONS[field]);
  await credentialBroker.serverUse<void>({
    service: "acp",
    field,
    toolName: ACP_SPAWN_TOOL,
    execute: async (value) => {
      for (const envVar of envVars) env[envVar] = value;
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
 *      ambient API key — but ONLY on local (non-platform) assistants. This
 *      preserves local users who export a daemon-level `ANTHROPIC_API_KEY` /
 *      `CLAUDE_CODE_OAUTH_TOKEN`: sibling PR F1 strips the daemon's ambient env
 *      from the spawned agent, so the only way an ambient cred reaches the
 *      adapter is for us to read it here and inject it via the returned
 *      `config.env` (which survives the F1 strip). On platform-hosted pods the
 *      daemon's ambient LLM key is an OPERATOR/PROVIDER credential, NOT the
 *      agent user's BYO cred — injecting it would leak the operator key AND
 *      mask a missing/broker-denied user credential, so on platform the ambient
 *      route is skipped entirely (resolution stops at agent.env + vault and the
 *      caller's preflight throws). This mirrors the codex-acp gating below.
 */
async function resolveLlmCredential(
  env: Record<string, string>,
): Promise<void> {
  // (1) Explicit agent.env credential wins outright — never compete with it.
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return;

  // (2) Vault: prefer the OAuth token, fall back to an Anthropic API key.
  await resolveAcpCredential(
    env,
    ["CLAUDE_CODE_OAUTH_TOKEN"],
    "claude_oauth_token",
  );
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    await resolveAcpCredential(env, ["ANTHROPIC_API_KEY"], "anthropic_api_key");
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return;

  // (3) Ambient process.env: same OAuth-preferred ordering. LOCAL-ONLY
  // (non-platform). On platform-hosted pods the daemon's ambient
  // CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY is an OPERATOR/PROVIDER key, NOT
  // the agent user's credential. Passing it through would leak the operator key
  // to the untrusted ACP agent AND mask a missing/broker-denied user cred, so
  // on platform we resolve ONLY from agent.env + vault and never consult
  // ambient env. Local dev keeps the fallback: F1 strips the daemon's ambient
  // env from the spawned subprocess, so we re-inject it here. Injected into the
  // returned env so it survives F1's spawn-env strip.
  if (getIsPlatform()) return;
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
 * Resolve the optional git/dev credential and wire it up so the agent can both
 * run the `gh` CLI AND `git clone/push` over plain HTTPS. Applies to EVERY
 * adapter (claude-agent-acp, codex-acp, …) — any agent with a linked git token
 * should be able to clone and push. Never required: if no token resolves we
 * inject nothing and the spawn proceeds (the agent simply has no git auth).
 *
 * Two pieces are needed because `GH_TOKEN` alone does NOT authenticate a plain
 * `git` invocation — it only helps the `gh` CLI:
 *  1. `GH_TOKEN` for the `gh` CLI.
 *  2. A pure-env git config (no files written) that rewrites GitHub HTTPS URLs
 *     to embed the token, so `git clone https://github.com/...` and `git push`
 *     authenticate transparently. Git reads ad-hoc config from
 *     `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, so we
 *     append an `url.<authed>.insteadOf = https://github.com/` entry.
 *
 * The injected vars (`GH_TOKEN`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`,
 * `GIT_CONFIG_VALUE_*`) are NOT in F1's spawn-env strip sets
 * (`ACP_STRIPPED_SECRET_ENV_VARS` / `ACP_STRIPPED_CONTROL_PLANE_ENV_VARS` in
 * `tools/terminal/safe-env.ts`), and `prepare-agent-env`'s returned `config.env`
 * is applied LAST in `buildAgentSpawnEnv`, so they survive into the subprocess.
 *
 * If `GIT_CONFIG_COUNT` is already set (by an `acp.agents.<id>.env` override or
 * an earlier injection), we APPEND at the next index rather than clobbering, so
 * the user's own ad-hoc git config entries are preserved.
 */
async function resolveGitCredential(
  env: Record<string, string>,
): Promise<void> {
  await resolveAcpCredential(env, ["GH_TOKEN"], "git_token");
  const token = env.GH_TOKEN;
  if (!token) return;

  // Append a git URL-rewrite entry so plain HTTPS git operations authenticate.
  // Parse any existing count defensively — a non-numeric value means we start
  // fresh rather than produce a NaN index that git would ignore.
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0;
  env.GIT_CONFIG_COUNT = String(base + 1);
  env[`GIT_CONFIG_KEY_${base}`] =
    `url.https://x-access-token:${token}@github.com/.insteadOf`;
  env[`GIT_CONFIG_VALUE_${base}`] = "https://github.com/";
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
 * For `claude-agent-acp` the agent needs ONE of two LLM credentials:
 *   1. LLM auth — `CLAUDE_CODE_OAUTH_TOKEN` (preferred) OR `ANTHROPIC_API_KEY`,
 *      resolved by precedence: explicit `acp.agents.<id>.env` in `config.json`
 *      wins, then the secure store (`acp/claude_oauth_token` /
 *      `acp/anthropic_api_key`) read through the credential broker, then —
 *      LOCAL-ONLY (`!getIsPlatform()`) — the ambient `process.env`. On
 *      platform-hosted pods the daemon's ambient LLM key is an OPERATOR/PROVIDER
 *      credential, NOT the user's BYO cred, so the ambient route is skipped and
 *      resolution stops at agent.env + vault (mirrors the codex-acp gating
 *      below). Once a source supplies a credential we never inject a competing
 *      one over it (the adapter prefers OAuth when both are set, so an explicit
 *      API key must not be shadowed by a vault/ambient OAuth token — and vice
 *      versa).
 * After resolution, this asserts at least one LLM credential is present
 * before spawning. The "fail-fast" throw is symmetric with the existing
 * `binary_not_found` preflight in `resolveAcpAgent` and strictly better
 * than a `warn` + zombie subprocess 10 seconds later.
 *
 * For `codex-acp` the same two-route resolution applies to the user's
 * OpenAI/Codex API key, injected as both `OPENAI_API_KEY` and
 * `CODEX_API_KEY` (the codex CLI accepts either). The config.json override
 * may set either var; an override under one satisfies the requirement and
 * the vault is not consulted. The vault field is `acp/openai_api_key`.
 *
 * codex-acp adds a THIRD, lowest-precedence, LOCAL-ONLY route: the daemon's
 * ambient `process.env.OPENAI_API_KEY` / `process.env.CODEX_API_KEY`. The
 * full precedence is:
 *   1. agent.env override (OPENAI_API_KEY/CODEX_API_KEY) — always allowed
 *      (user config).
 *   2. vault `acp/openai_api_key` — always allowed (user BYO cred).
 *   3. ambient `process.env` OPENAI_API_KEY/CODEX_API_KEY — ONLY when
 *      `getIsPlatform()` is false (local). On platform-hosted pods the
 *      daemon's ambient key is an OPERATOR/PROVIDER key (provider env
 *      fallback / operator broker key), NOT the agent user's credential.
 *      Passing it to the agent-driven session would leak the operator key
 *      AND mask a missing/broker-denied user credential, so on platform the
 *      ambient route is skipped entirely.
 * The ambient fallback exists for backward compatibility with existing local
 * users who `export OPENAI_API_KEY`/`CODEX_API_KEY` at the daemon level: the
 * sibling PR (F1) strips the daemon's ambient env from the spawned agent
 * subprocess, so an ambient key only reaches the codex adapter if this helper
 * reads it and re-injects it into the returned `env` (which survives F1's
 * strip). Whichever source wins, BOTH `OPENAI_API_KEY` and `CODEX_API_KEY`
 * are injected.
 *
 * If NO codex credential resolves from the allowed routes (on platform: only
 * agent.env + vault; on local: agent.env + vault + ambient), the missing-key
 * handling is PLATFORM-SCOPED:
 *   - Platform-hosted (`getIsPlatform()` true): THROW `FailedDependencyError`.
 *     Hosted pods have no interactive terminal, so the `codex login`
 *     (ChatGPT OAuth) flow is unavailable and an API key is mandatory.
 *   - Local (non-platform): DO NOT throw. A locally logged-in `codex` CLI
 *     authenticates from its own stored auth state (`~/.codex`, via
 *     `codex login`), so the spawn must be allowed to proceed without us
 *     forcing any `OPENAI_API_KEY`/`CODEX_API_KEY`. We inject nothing extra
 *     and let the adapter read its own auth state.
 *
 * For BOTH adapters, an OPTIONAL git/dev credential is resolved last so the
 * agent can clone/push: `GH_TOKEN` from `acp.agents.<id>.env` or the secure
 * store (`acp/git_token`). When present we also set the `GIT_CONFIG_*`
 * URL-rewrite env vars so plain `git clone/push` over HTTPS authenticates (a
 * bare `GH_TOKEN` only covers the `gh` CLI). Never required — a missing git
 * token leaves the env untouched. See {@link resolveGitCredential}.
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
  }

  if (commandBasename === "codex-acp") {
    // The codex-acp adapter shells out to the `codex` CLI, which accepts the
    // user's OpenAI/Codex API key via either CODEX_API_KEY or OPENAI_API_KEY.
    // A config.json env override (under either var) wins over the vault, so
    // explicit per-workspace/rotated keys are never silently clobbered. One
    // vault `acp/openai_api_key` read fills BOTH vars (shared helper).
    await resolveAcpCredential(
      env,
      ["OPENAI_API_KEY", "CODEX_API_KEY"],
      "openai_api_key",
    );
    if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY && !getIsPlatform()) {
      // Lowest-precedence fallback: the daemon's ambient process.env. This is
      // LOCAL-ONLY (non-platform). On platform-hosted pods the daemon's
      // ambient OPENAI_API_KEY/CODEX_API_KEY is an OPERATOR/PROVIDER key (the
      // provider env fallback / operator broker key), NOT the agent user's
      // credential. Passing it through would (a) leak an operator key to the
      // agent-driven codex-acp session and (b) mask a missing/broker-denied
      // user credential. So on platform we resolve ONLY from agent.env +
      // vault `acp/openai_api_key` (the user's BYO cred) and never consult
      // ambient env. Local dev keeps the ambient fallback: sibling PR F1
      // strips the daemon's ambient env from the spawned subprocess, so we
      // re-inject it here to preserve existing local users who exported the
      // key at the daemon level. Inject BOTH var names from whichever ambient
      // var is set so the codex CLI sees a consistent credential.
      const ambientKey =
        process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY;
      if (ambientKey) {
        env.OPENAI_API_KEY = ambientKey;
        env.CODEX_API_KEY = ambientKey;
      }
    }
    if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
      // No credential from any route. The requirement is platform-scoped:
      // hosted pods have no interactive `codex login`, so an API key is
      // mandatory and we fail fast. Local assistants CAN authenticate via the
      // codex CLI's own stored OAuth state (`codex login`, ~/.codex), so we
      // let the spawn proceed without forcing any key and let the adapter
      // read its own auth state.
      if (getIsPlatform()) {
        throw new FailedDependencyError(
          "codex-acp requires an OpenAI/Codex API key (OPENAI_API_KEY or CODEX_API_KEY) " +
            "for hosted/agent-driven spawns. Resolution order: acp.agents.<id>.env in " +
            "config.json → vault (assistant credentials set --service acp --field " +
            "openai_api_key <key>) → ambient OPENAI_API_KEY/CODEX_API_KEY in the daemon " +
            "environment. None were set. The interactive `codex login` (ChatGPT OAuth) " +
            "flow is a local-only path and is not available on platform-hosted pods, so " +
            "an API key is required here.",
        );
      }
      log.debug(
        "codex-acp: no API key resolved (agent.env/vault/ambient); proceeding " +
          "on local (non-platform) assistant so the codex CLI can use its own " +
          "stored OAuth/auth state (codex login, ~/.codex).",
      );
    }
  }

  // Git auth (optional): inject for ANY adapter so the agent can both run the
  // `gh` CLI and `git clone/push` over HTTPS. Resolved after the LLM creds and
  // never required — a missing git token leaves the env untouched.
  await resolveGitCredential(env);

  return { ...agentConfig, env };
}
