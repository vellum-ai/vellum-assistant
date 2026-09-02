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
  type CredentialMetadata,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { serverUseDenialReason } from "../tools/credentials/tool-policy.js";
import { getLogger } from "../util/logger.js";
import {
  claudeTokenDigest,
  claudeTokenRefusedByClaude,
} from "./acp-auth-marker-store.js";
import {
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  classifyAnthropicToken,
} from "./acp-credentials.js";
import { lookupAcpAgentConfig } from "./resolve-agent.js";
import type { AcpAgentConfig } from "./types.js";

const log = getLogger("acp:prepare-agent-env");

const ACP_SPAWN_TOOL = "acp_spawn";

/**
 * `usageDescription` recorded on `acp/claude_oauth_token` when a record is
 * created, shared by the spawn-time ensure and the Connect repair so the two
 * paths can't describe the same credential differently.
 */
export const ACP_CLAUDE_OAUTH_USAGE_DESCRIPTION =
  "Claude OAuth token for ACP agent authentication";

/**
 * Stable, machine-readable marker carried on the `FailedDependencyError.details`
 * when a `claude-agent-acp` spawn is missing `CLAUDE_CODE_OAUTH_TOKEN`. Threaded
 * through the tool result / error payload as a structured field so clients can
 * offer the inline "Connect Claude Code" flow instead of re-parsing the human
 * message string. Kept in lockstep with the web literal in
 * `clients/web/src/domains/chat/utils/acp-connect.ts`.
 */
export const ACP_CLAUDE_OAUTH_MISSING_CODE = "acp_claude_oauth_missing";

/**
 * The metadata an `acp/<field>` credential has once the `acp_spawn` read policy
 * is ensured, given what is stored now. This is the single definition of that
 * decision: {@link ensureAcpCredentialPolicy} persists the result and
 * {@link acpSpawnCredentialDenialReason} evaluates it without writing.
 *
 * The policy is only repaired for legacy/unmanaged cases:
 *
 * - No metadata at all: a record with `allowedTools: ["acp_spawn"]` and the
 *   caller's `usageDescription`.
 * - Metadata with an empty `allowedTools`: default provisioning path (user ran
 *   `credentials set` without `--allowed-tools`), so `acp_spawn` is added.
 * - Metadata with a non-empty `allowedTools`: explicit policy set by the
 *   user/admin, returned as the very same object so callers can tell by
 *   identity that there is nothing to persist. It stands even when `acp_spawn`
 *   is absent; the broker denies the read and the caller decides whether that's
 *   fatal.
 *
 * Everything else on an existing record, `allowedDomains` included, is
 * preserved.
 */
function projectEnsuredAcpPolicy(
  meta: CredentialMetadata | undefined,
  field: string,
  usageDescription?: string,
): CredentialMetadata {
  if (!meta) {
    return {
      credentialId: "",
      service: ACP_SERVICE,
      field,
      allowedTools: [ACP_SPAWN_TOOL],
      allowedDomains: [],
      usageDescription,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  if ((meta.allowedTools ?? []).length === 0) {
    return { ...meta, allowedTools: [ACP_SPAWN_TOOL] };
  }
  return meta;
}

/**
 * Bring the stored metadata for `acp/<field>` up to the policy
 * {@link projectEnsuredAcpPolicy} describes, writing only the fields that
 * projection decides and only when it differs from what is stored.
 */
export function ensureAcpCredentialPolicy(
  field: string,
  usageDescription: string,
): void {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  const ensured = projectEnsuredAcpPolicy(meta, field, usageDescription);
  if (ensured === meta) {
    return;
  }
  upsertCredentialMetadata(ACP_SERVICE, field, {
    allowedTools: ensured.allowedTools,
    usageDescription: ensured.usageDescription,
  });
}

/**
 * Make `acp/<field>` readable by the spawn: union `acp_spawn` into any existing
 * `allowedTools` and drop any domain restriction, in ONE write and only when the
 * stored record fails either half. This is the whole repair the Connect flow
 * performs, so a new dimension of {@link serverUseDenialReason} is repaired in
 * exactly one place.
 *
 * Unlike {@link ensureAcpCredentialPolicy} (which PRESERVES an explicit non-empty
 * policy so a passive spawn can't silently widen it), this is for the EXPLICIT
 * Connect flow: a user connecting Claude is a deliberate opt-in to `acp_spawn`,
 * so granting it makes the CTA actually repair a policy-denied credential instead
 * of dead-looping the missing-token card. Domains are cleared under the same
 * opt-in: this field is OAuth-only and server-use-only, and the broker refuses a
 * domain-restricted credential server-side, so a lingering restriction would keep
 * every spawn failing even after a successful connect.
 */
export function repairAcpSpawnPolicy(
  field: string,
  usageDescription: string,
): void {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  const tools = meta?.allowedTools ?? [];
  const spawnAllowed = tools.includes(ACP_SPAWN_TOOL);
  const domainUnrestricted = (meta?.allowedDomains ?? []).length === 0;
  if (meta && spawnAllowed && domainUnrestricted) {
    return;
  }
  upsertCredentialMetadata(ACP_SERVICE, field, {
    allowedTools: spawnAllowed ? tools : [...tools, ACP_SPAWN_TOOL],
    allowedDomains: [],
    // Only a fresh record takes the description; an existing one keeps its own.
    ...(meta ? {} : { usageDescription }),
  });
}

/**
 * Why the `acp_spawn` broker read for `acp/<field>` would be denied, or
 * `undefined` when it would be permitted. Lets a connected-status check avoid
 * reporting "connected" for a token the spawn is policy-denied from reading
 * (which would otherwise hide the repair CTA and trap the user in a
 * missing-token loop).
 *
 * The verdict comes from `serverUseDenialReason`, the single policy source the
 * broker itself consults, so the status check and the spawn read can never
 * disagree. The stored metadata is first run through
 * {@link projectEnsuredAcpPolicy}, the same repair the spawn persists, computed
 * in memory and never written: this runs on a side-effect-free GET route, so it
 * has to predict what the spawn's ensure-then-read sequence would do rather
 * than perform it.
 */
export function acpSpawnCredentialDenialReason(
  field: string,
): string | undefined {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  return serverUseDenialReason(
    projectEnsuredAcpPolicy(meta, field),
    ACP_SPAWN_TOOL,
    ACP_SERVICE,
    field,
  );
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
  if (env[envVar]) {
    return;
  }
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
 * Whether a configured `CLAUDE_CODE_OAUTH_TOKEN` should stand down.
 *
 * True once Claude has refused that exact value and the vault offers a
 * different one. Only then: with nothing to fall back to, dropping it would
 * trade a token that fails for no token at all, and the missing-token branch
 * would report the wrong reason.
 *
 * `acp-claude-oauth` is imported at call time because it reaches back into
 * this module for the spawn policy helpers, and it is the module authorised to
 * read this vault field, so the dependency runs one way at load and the other
 * here.
 */
async function configuredClaudeTokenStandsDown(
  configured: string | undefined,
): Promise<boolean> {
  if (!configured || !claudeTokenRefusedByClaude(configured)) {
    return false;
  }
  const { storedClaudeTokenDigest } = await import("./acp-claude-oauth.js");
  const stored = await storedClaudeTokenDigest();
  return stored !== undefined && stored !== claudeTokenDigest(configured);
}

/**
 * Digest of the Claude token a spawn of `agentId` would resolve now, or
 * `undefined` when it would find none.
 *
 * The credential a marker is judged against, and the same precedence
 * `prepareAgentEnv` applies rather than a second derivation of it. A
 * vault-only answer is wrong in both directions: a user who repairs auth by
 * setting `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` would keep seeing a
 * card for a failure the next spawn will not repeat, and one whose configured
 * token is the broken one would see none.
 *
 * Deliberately does not check that the agent's binary exists. A marker
 * outlives the run that wrote it, and an uninstalled adapter says nothing
 * about whether its credential was replaced.
 */
export async function resolvedClaudeCredentialDigest(
  agentId: string,
): Promise<string | undefined> {
  const configured =
    lookupAcpAgentConfig(agentId)?.env?.CLAUDE_CODE_OAUTH_TOKEN;
  const usable =
    configured && classifyAnthropicToken(configured) !== "api_key"
      ? configured
      : undefined;
  if (usable && !(await configuredClaudeTokenStandsDown(usable))) {
    return claudeTokenDigest(usable);
  }
  const { storedClaudeTokenDigest } = await import("./acp-claude-oauth.js");
  return storedClaudeTokenDigest();
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
  let credentialDigest: string | undefined;

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
    // A configured token Claude has already refused stands down in favour of
    // the vault. Config otherwise wins, so honouring it here would resolve the
    // same revoked value and raise the card again on every retry.
    if (await configuredClaudeTokenStandsDown(env.CLAUDE_CODE_OAUTH_TOKEN)) {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    let missReason: string | undefined;
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      missReason = await injectCredential(
        env,
        ACP_OAUTH_TOKEN_FIELD,
        "CLAUDE_CODE_OAUTH_TOKEN",
        ACP_CLAUDE_OAUTH_USAGE_DESCRIPTION,
      );
    }
    // Any api-key-shaped value still standing here came from the vault read:
    // the config override was already dropped above, and the read only runs
    // when the override left the var unset.
    const storedValueIsApiKeyShaped =
      env.CLAUDE_CODE_OAUTH_TOKEN !== undefined &&
      classifyAnthropicToken(env.CLAUDE_CODE_OAUTH_TOKEN) === "api_key";
    dropApiKeyOauthToken();
    // Identity of the token this spawn will actually run with, whichever
    // source survived the resolution above. Recorded on the history row if
    // Claude refuses it, which is what lets the marker be compared against the
    // credential a later spawn would resolve instead of relying on a sweep.
    credentialDigest = env.CLAUDE_CODE_OAUTH_TOKEN
      ? claudeTokenDigest(env.CLAUDE_CODE_OAUTH_TOKEN)
      : undefined;
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      // The operator's record of WHY the spawn has no token. `missReason` is
      // the broker's own reason string and the rest are policy verdicts, so no
      // field can carry the credential value.
      const policyDenialReason = acpSpawnCredentialDenialReason(
        ACP_OAUTH_TOKEN_FIELD,
      );
      log.warn(
        {
          field: ACP_OAUTH_TOKEN_FIELD,
          missReason,
          policyBlocked: policyDenialReason !== undefined,
          apiKeyShaped: storedValueIsApiKeyShaped,
        },
        "Claude OAuth token not injected for acp_spawn",
      );
      // Carry the stable marker as structured `details` so the client renders
      // the inline "Connect Claude Code" card. The message itself is the tool
      // result the model reads at the failure moment, so it directs the model
      // AT that card and away from CLI/token-paste workarounds — otherwise the
      // model relays a `claude setup-token` / paste-a-token flow that the card
      // exists to replace. The CLI command stays only as a headless fallback.
      // A policy-blocked read is a different repair story from an absent value,
      // so the opening states which one happened. The guidance after it is
      // shared: the Connect card fixes both.
      const opening = policyDenialReason
        ? "claude-agent-acp cannot read the Claude OAuth token: the credential " +
          "policy on acp/claude_oauth_token blocks the acp_spawn read, so " +
          "CLAUDE_CODE_OAUTH_TOKEN is not set for the spawn. Clicking Connect " +
          "signs in again and repairs that policy. "
        : "claude-agent-acp needs a Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN), " +
          "which is not set. ";
      throw new FailedDependencyError(
        opening +
          'The app shows the user an inline "Connect Claude ' +
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

  return {
    ...agentConfig,
    env,
    credentialDigest,
  };
}
