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
import type { AcpAgentConfig } from "./types.js";

const ACP_SPAWN_TOOL = "acp_spawn";

const log = getLogger("acp:prepare-agent-env");

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

  return { ...agentConfig, env };
}
