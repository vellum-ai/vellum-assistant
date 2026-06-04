/**
 * Tests for `prepareAgentEnv` — the shared helper that injects required env
 * vars onto an `AcpAgentConfig` and preflights that they're set.
 *
 * The route-level test in `runtime/routes/acp-routes.test.ts` covers the same
 * behavior through the HTTP handler; these tests pin the helper in isolation
 * so the contract is clear and a future refactor can't silently break it.
 *
 * Credential reads go through the credential broker (`serverUse`), so we
 * mock the broker and metadata store rather than the raw secure-keys backend.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs — wired BEFORE importing the helper via dynamic import.
// ---------------------------------------------------------------------------

/** Simulates the credential metadata store. */
const metadataStore = new Map<
  string,
  { allowedTools: string[]; usageDescription?: string }
>();

mock.module("../../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) => {
    const key = `${service}/${field}`;
    const entry = metadataStore.get(key);
    if (!entry) return undefined;
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: entry.allowedTools,
      allowedDomains: [],
      usageDescription: entry.usageDescription,
      createdAt: 0,
      updatedAt: 0,
    };
  },
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: { allowedTools?: string[]; usageDescription?: string },
  ) => {
    const key = `${service}/${field}`;
    const existing = metadataStore.get(key);
    metadataStore.set(key, {
      allowedTools: policy?.allowedTools ?? existing?.allowedTools ?? [],
      usageDescription:
        policy?.usageDescription ?? existing?.usageDescription,
    });
    return {
      credentialId: `cred-${key}`,
      service,
      field,
      allowedTools: metadataStore.get(key)!.allowedTools,
      allowedDomains: [],
      createdAt: 0,
      updatedAt: 0,
    };
  },
}));

/**
 * Simulates the credential broker's serverUse method. The vault stores
 * plaintext values keyed by `service/field`; the broker enforces tool
 * policy via the metadata store before passing the value to the callback.
 */
const vaultStore = new Map<string, string>();

mock.module("../../tools/credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async <T>(request: {
      service: string;
      field: string;
      toolName: string;
      execute: (value: string) => Promise<T>;
    }) => {
      const key = `${request.service}/${request.field}`;
      const meta = metadataStore.get(key);
      if (!meta) {
        return { success: false, reason: `No credential found for ${key}` };
      }
      if (!meta.allowedTools.includes(request.toolName)) {
        return {
          success: false,
          reason: `Tool "${request.toolName}" not allowed`,
        };
      }
      const value = vaultStore.get(key);
      if (!value) {
        // Mirror the real broker's not-found sentinel verbatim so the helper's
        // miss-vs-denial classification is exercised against the same wording.
        return {
          success: false,
          reason: `Credential metadata exists but no stored value for ${key}`,
        };
      }
      const result = await request.execute(value);
      return { success: true, result };
    },
  },
}));

const { prepareAgentEnv } = await import("../prepare-agent-env.js");

/**
 * Restore (or delete) a process.env var to a previously captured value.
 * Used by the codex ambient-fallback tests so they don't leak into one
 * another or into the real daemon environment the suite runs under.
 */
function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = prev;
  }
}

// Snapshot + clear any ambient codex/openai creds the test daemon may have
// exported, so the vault/agent.env/throw paths exercise the intended source
// rather than silently picking up an ambient key. Restored in afterEach.
//
// IS_PLATFORM gates the codex-acp missing-key handling (throw on hosted pods,
// proceed locally). `getIsPlatform()` reads `process.env.IS_PLATFORM` via the
// dependency-free env-registry flag helper, so we toggle it through the env
// var directly. Default each test to the LOCAL (non-platform) posture and
// snapshot/restore so a leaked value can't cross-contaminate.
let savedOpenAiKey: string | undefined;
let savedCodexKey: string | undefined;
let savedIsPlatform: string | undefined;
let savedClaudeOauth: string | undefined;
let savedAnthropicKey: string | undefined;

beforeEach(() => {
  metadataStore.clear();
  vaultStore.clear();
  // Ambient daemon-level creds are an explicit fallback source; snapshot then
  // clear them so a value leaking in from the test runner's own env can't mask
  // the intended precedence source. Restored in afterEach.
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  savedCodexKey = process.env.CODEX_API_KEY;
  savedIsPlatform = process.env.IS_PLATFORM;
  savedClaudeOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.IS_PLATFORM;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  restoreEnv("OPENAI_API_KEY", savedOpenAiKey);
  restoreEnv("CODEX_API_KEY", savedCodexKey);
  restoreEnv("IS_PLATFORM", savedIsPlatform);
  restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", savedClaudeOauth);
  restoreEnv("ANTHROPIC_API_KEY", savedAnthropicKey);
});

// ---------------------------------------------------------------------------
// Helper to seed a vault entry (simulates `assistant credentials set`).
// ---------------------------------------------------------------------------

function seedVaultToken(token: string): void {
  vaultStore.set("acp/claude_oauth_token", token);
}

function seedVaultOpenAiKey(key: string): void {
  vaultStore.set("acp/openai_api_key", key);
}

function seedVaultField(field: string, value: string): void {
  vaultStore.set(`acp/${field}`, value);
}

describe("prepareAgentEnv — claude-agent-acp gating", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the vault via the broker when agent.env has no override", async () => {
    seedVaultToken("vault-AAA");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-AAA");
  });

  test("auto-registers metadata with acp_spawn in allowedTools when none exists", async () => {
    seedVaultToken("vault-auto-meta");

    await prepareAgentEnv({ command: "claude-agent-acp", args: [] });

    const meta = metadataStore.get("acp/claude_oauth_token");
    expect(meta).toBeDefined();
    expect(meta!.allowedTools).toContain("acp_spawn");
  });

  test("adds acp_spawn to metadata with empty allowedTools (default provisioning path)", async () => {
    metadataStore.set("acp/claude_oauth_token", {
      allowedTools: [],
    });
    seedVaultToken("vault-augment");

    await prepareAgentEnv({ command: "claude-agent-acp", args: [] });

    const meta = metadataStore.get("acp/claude_oauth_token");
    expect(meta!.allowedTools).toContain("acp_spawn");
  });

  test("respects explicit tool policy that excludes acp_spawn", async () => {
    metadataStore.set("acp/claude_oauth_token", {
      allowedTools: ["other_tool"],
    });
    seedVaultToken("vault-restricted");

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");

    const meta = metadataStore.get("acp/claude_oauth_token");
    expect(meta!.allowedTools).toEqual(["other_tool"]);
  });

  test("LOCAL: a broker POLICY DENIAL on the OAuth field THROWS and does NOT fall through to the ambient process.env key", async () => {
    // The OAuth credential IS stored but its policy excludes acp_spawn (the user
    // explicitly blocked ACP agent access). A daemon-level ambient key is also
    // present. On LOCAL the ambient fallback is normally allowed, but a policy
    // DENIAL must stop the chain so the operator/ambient key is never injected
    // and the denial is not silently masked. (P2 policy-bypass fix.)
    metadataStore.set("acp/claude_oauth_token", {
      allowedTools: ["other_tool"],
    });
    seedVaultToken("vault-restricted");
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-should-not-leak";

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("acp_spawn");
  });

  test("LOCAL: a genuine MISS still falls through to the ambient key (denial-vs-miss distinction)", async () => {
    // No stored credential at all (a MISS, not a denial). The ambient fallback
    // remains intact for genuine misses — only policy denials stop the chain.
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("ambient-anthropic");
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-BBB" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-BBB");
  });

  test("agent.env override wins over the vault entry (precedence pin)", async () => {
    seedVaultToken("vault-CCC");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-DDD" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-DDD");
  });

  test("preserves unrelated env vars on agent.env when injecting from the vault", async () => {
    seedVaultToken("vault-EEE");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { OTHER_VAR: "keep-me" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-EEE");
    expect(prepared.env?.OTHER_VAR).toBe("keep-me");
  });

  test("throws FailedDependencyError when no token is provided from either route", async () => {
    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("gates on the resolved command BASENAME (alias to /custom/path/claude-agent-acp still gets the token)", async () => {
    seedVaultToken("vault-FFF");

    const prepared = await prepareAgentEnv({
      command: "/opt/bin/claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-FFF");
  });

  test("falls back to ANTHROPIC_API_KEY from the vault when no OAuth token exists", async () => {
    seedVaultField("anthropic_api_key", "vault-anthropic-key");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("vault-anthropic-key");
  });

  test("accepts ANTHROPIC_API_KEY from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { ANTHROPIC_API_KEY: "config-anthropic" },
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("config-anthropic");
  });

  test("prefers the OAuth token over the Anthropic API key when both are present", async () => {
    seedVaultToken("vault-oauth");
    seedVaultField("anthropic_api_key", "vault-anthropic-key");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-oauth");
    // API-key fallback is only consulted when no OAuth token resolves.
    expect(prepared.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("agent.env ANTHROPIC_API_KEY override wins over the vault entry", async () => {
    seedVaultField("anthropic_api_key", "vault-anthropic-key");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { ANTHROPIC_API_KEY: "config-anthropic" },
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("config-anthropic");
  });

  test("explicit agent.env ANTHROPIC_API_KEY wins over a vault OAuth token (no OAuth-over-API-key)", async () => {
    // The precedence bug: a stored OAuth token must NOT be injected over an
    // API key the user intentionally set via config.json, because the adapter
    // prefers OAuth when both are present.
    seedVaultToken("vault-oauth");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { ANTHROPIC_API_KEY: "config-anthropic" },
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("config-anthropic");
    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("explicit agent.env CLAUDE_CODE_OAUTH_TOKEN wins over a vault Anthropic API key", async () => {
    seedVaultField("anthropic_api_key", "vault-anthropic-key");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-oauth" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-oauth");
    expect(prepared.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("LOCAL: falls back to ambient process.env.ANTHROPIC_API_KEY when neither agent.env nor the vault has a credential", async () => {
    // beforeEach leaves IS_PLATFORM unset (local), where the ambient fallback
    // is allowed.
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("ambient-anthropic");
    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("LOCAL: falls back to ambient process.env.CLAUDE_CODE_OAUTH_TOKEN, preferred over an ambient API key", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-oauth");
    expect(prepared.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("PLATFORM + ambient process.env.ANTHROPIC_API_KEY only (no agent.env, no vault) → THROWS; operator key is NOT injected", async () => {
    // On platform-hosted pods the daemon's ambient ANTHROPIC_API_KEY is an
    // OPERATOR/PROVIDER key, NOT the agent user's BYO credential. The ambient
    // fallback is local-only, so on platform this key must be ignored: with no
    // agent.env override and no user vault cred, the preflight fails fast rather
    // than leaking the operator key into the untrusted ACP agent.
    process.env.IS_PLATFORM = "true";
    process.env.ANTHROPIC_API_KEY = "operator-ambient-anthropic";

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("PLATFORM + ambient process.env.CLAUDE_CODE_OAUTH_TOKEN only → THROWS; operator key is NOT injected", async () => {
    process.env.IS_PLATFORM = "true";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-ambient-oauth";

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("PLATFORM + ambient key but vault cred present → vault wins; ambient operator key ignored", async () => {
    // The user's vault BYO cred is always allowed on platform; the ambient
    // operator key must never be the resolved source.
    process.env.IS_PLATFORM = "true";
    process.env.ANTHROPIC_API_KEY = "operator-ambient-anthropic";
    seedVaultToken("vault-user-oauth");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-user-oauth");
    expect(prepared.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("vault credential wins over the ambient process.env fallback", async () => {
    seedVaultToken("vault-oauth");
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-oauth");
    // Ambient is only consulted when neither agent.env nor the vault supplies one.
    expect(prepared.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("full precedence: agent.env API key beats both a vault OAuth token and an ambient OAuth token", async () => {
    seedVaultToken("vault-oauth");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { ANTHROPIC_API_KEY: "config-anthropic" },
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("config-anthropic");
    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("throws when no LLM credential exists in agent.env, the vault, or the ambient env", async () => {
    // No vault entry, no agent.env, no ambient cred (cleared in beforeEach).
    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("injects GH_TOKEN from the vault when a git token is present", async () => {
    seedVaultToken("vault-oauth");
    seedVaultField("git_token", "vault-git");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.GH_TOKEN).toBe("vault-git");
  });

  test("a git token also wires the GIT_CONFIG_* URL-rewrite so plain git over HTTPS authenticates", async () => {
    seedVaultToken("vault-oauth");
    seedVaultField("git_token", "vault-git");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    // GH_TOKEN covers the gh CLI; the GIT_CONFIG_* trio makes a bare
    // `git clone/push` over HTTPS rewrite github.com URLs to embed the token.
    expect(prepared.env?.GH_TOKEN).toBe("vault-git");
    expect(prepared.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(prepared.env?.GIT_CONFIG_KEY_0).toBe(
      "url.https://x-access-token:vault-git@github.com/.insteadOf",
    );
    expect(prepared.env?.GIT_CONFIG_VALUE_0).toBe("https://github.com/");
  });

  test("does NOT set GIT_CONFIG_* when no git token is present", async () => {
    seedVaultToken("vault-oauth");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.GH_TOKEN).toBeUndefined();
    expect(prepared.env?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(prepared.env?.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(prepared.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  test("appends to an existing GIT_CONFIG_COUNT rather than clobbering it", async () => {
    seedVaultToken("vault-oauth");
    seedVaultField("git_token", "vault-git");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      // Simulate a user-supplied ad-hoc git config entry already in agent.env.
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Existing User",
      },
    });

    // Existing entry is preserved; ours is appended at the next index.
    expect(prepared.env?.GIT_CONFIG_COUNT).toBe("2");
    expect(prepared.env?.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(prepared.env?.GIT_CONFIG_VALUE_0).toBe("Existing User");
    expect(prepared.env?.GIT_CONFIG_KEY_1).toBe(
      "url.https://x-access-token:vault-git@github.com/.insteadOf",
    );
    expect(prepared.env?.GIT_CONFIG_VALUE_1).toBe("https://github.com/");
  });

  test("git token works alongside the API-key-only LLM credential", async () => {
    seedVaultField("anthropic_api_key", "vault-anthropic-key");
    seedVaultField("git_token", "vault-git");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("vault-anthropic-key");
    expect(prepared.env?.GH_TOKEN).toBe("vault-git");
  });

  test("agent.env GH_TOKEN override wins over the vault entry", async () => {
    seedVaultToken("vault-oauth");
    seedVaultField("git_token", "vault-git");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { GH_TOKEN: "config-git" },
    });

    expect(prepared.env?.GH_TOKEN).toBe("config-git");
  });

  test("does NOT inject GH_TOKEN when no git token is present", async () => {
    seedVaultToken("vault-oauth");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.GH_TOKEN).toBeUndefined();
  });

  test("throws FailedDependencyError when NEITHER LLM credential is present", async () => {
    // A git token alone is not sufficient — an LLM credential is required.
    seedVaultField("git_token", "vault-git");

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("does NOT mutate the caller's agentConfig", async () => {
    seedVaultToken("vault-GGG");
    const original = {
      command: "claude-agent-acp",
      args: [],
      env: { OTHER: "keep" },
    };
    const beforeEnv = { ...original.env };

    const prepared = await prepareAgentEnv(original);

    expect(prepared).not.toBe(original);
    expect(prepared.env).not.toBe(original.env);
    expect(original.env).toEqual(beforeEnv);
    expect(original.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("prepareAgentEnv — codex-acp gating", () => {
  test("injects OPENAI_API_KEY + CODEX_API_KEY from the vault via the broker when agent.env has no override", async () => {
    seedVaultOpenAiKey("vault-openai-AAA");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-openai-AAA");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-openai-AAA");
  });

  test("auto-registers acp/openai_api_key metadata with acp_spawn when none exists", async () => {
    seedVaultOpenAiKey("vault-openai-auto-meta");

    await prepareAgentEnv({ command: "codex-acp", args: [] });

    const meta = metadataStore.get("acp/openai_api_key");
    expect(meta).toBeDefined();
    expect(meta!.allowedTools).toContain("acp_spawn");
  });

  test("respects explicit tool policy that excludes acp_spawn", async () => {
    // The broker denies the vault read (policy excludes acp_spawn), so no
    // credential resolves. On platform that is fatal; pin the throw under the
    // hosted posture so this asserts the denial, not the platform default.
    process.env.IS_PLATFORM = "true";
    metadataStore.set("acp/openai_api_key", { allowedTools: ["other_tool"] });
    seedVaultOpenAiKey("vault-openai-restricted");

    await expect(
      prepareAgentEnv({ command: "codex-acp", args: [] }),
    ).rejects.toThrow("OPENAI_API_KEY");

    const meta = metadataStore.get("acp/openai_api_key");
    expect(meta!.allowedTools).toEqual(["other_tool"]);
  });

  test("LOCAL: a broker POLICY DENIAL THROWS and does NOT fall through to the ambient process.env key", async () => {
    // The OpenAI key IS stored but its policy excludes acp_spawn, and a
    // daemon-level ambient key is present. On LOCAL the ambient fallback is
    // normally allowed, but a policy DENIAL must stop the chain so the
    // operator/ambient key is never injected and the denial is not masked.
    metadataStore.set("acp/openai_api_key", { allowedTools: ["other_tool"] });
    seedVaultOpenAiKey("vault-openai-restricted");
    process.env.OPENAI_API_KEY = "ambient-openai-should-not-leak";

    await expect(
      prepareAgentEnv({ command: "codex-acp", args: [] }),
    ).rejects.toThrow("acp_spawn");
  });

  test("accepts OPENAI_API_KEY from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OPENAI_API_KEY: "config-openai-BBB" },
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("config-openai-BBB");
  });

  test("accepts CODEX_API_KEY from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { CODEX_API_KEY: "config-codex-BBB" },
    });

    expect(prepared.env?.CODEX_API_KEY).toBe("config-codex-BBB");
  });

  test("agent.env override wins over the vault entry (precedence pin)", async () => {
    seedVaultOpenAiKey("vault-openai-CCC");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OPENAI_API_KEY: "config-openai-DDD" },
    });

    // Override satisfies the requirement; the vault is not consulted, so
    // CODEX_API_KEY is left untouched.
    expect(prepared.env?.OPENAI_API_KEY).toBe("config-openai-DDD");
    expect(prepared.env?.CODEX_API_KEY).toBeUndefined();
  });

  test("falls back to ambient process.env.OPENAI_API_KEY (no agent.env, no vault) — injects both vars", async () => {
    // beforeEach cleared ambient creds; afterEach restores them.
    process.env.OPENAI_API_KEY = "ambient-openai-XYZ";

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("ambient-openai-XYZ");
    expect(prepared.env?.CODEX_API_KEY).toBe("ambient-openai-XYZ");
  });

  test("falls back to ambient process.env.CODEX_API_KEY when only CODEX_API_KEY is set", async () => {
    process.env.CODEX_API_KEY = "ambient-codex-XYZ";

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("ambient-codex-XYZ");
    expect(prepared.env?.CODEX_API_KEY).toBe("ambient-codex-XYZ");
  });

  test("PLATFORM + ambient process.env.OPENAI_API_KEY only (no agent.env, no vault) → THROWS; operator key is NOT passed through", async () => {
    // On platform-hosted pods the daemon's ambient OPENAI_API_KEY is an
    // OPERATOR/PROVIDER key, NOT the agent user's credential. The ambient
    // fallback is local-only, so on platform this key must be ignored: with no
    // agent.env override and no user vault cred, the missing-key branch fires
    // and we fail fast rather than leaking the operator key into the spawn.
    process.env.IS_PLATFORM = "true";
    process.env.OPENAI_API_KEY = "operator-ambient-key";

    await expect(
      prepareAgentEnv({ command: "codex-acp", args: [] }),
    ).rejects.toThrow("codex-acp requires an OpenAI/Codex API key");
  });

  test("PLATFORM + ambient process.env.CODEX_API_KEY only → THROWS; operator key is NOT passed through", async () => {
    process.env.IS_PLATFORM = "true";
    process.env.CODEX_API_KEY = "operator-ambient-codex-key";

    await expect(
      prepareAgentEnv({ command: "codex-acp", args: [] }),
    ).rejects.toThrow("codex-acp requires an OpenAI/Codex API key");
  });

  test("PLATFORM + ambient key but vault cred present → vault wins; ambient operator key ignored", async () => {
    // The user's vault BYO cred is always allowed on platform; the ambient
    // operator key must never be the resolved source.
    process.env.IS_PLATFORM = "true";
    process.env.OPENAI_API_KEY = "operator-ambient-key";
    seedVaultOpenAiKey("vault-user-key");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-user-key");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-user-key");
  });

  test("vault wins over ambient process.env (precedence pin)", async () => {
    process.env.OPENAI_API_KEY = "ambient-loser";
    seedVaultOpenAiKey("vault-winner");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-winner");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-winner");
  });

  test("agent.env override wins over ambient process.env (precedence pin)", async () => {
    process.env.OPENAI_API_KEY = "ambient-loser";

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OPENAI_API_KEY: "config-winner" },
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("config-winner");
    expect(prepared.env?.CODEX_API_KEY).toBeUndefined();
  });

  test("PLATFORM + no key from any route → throws FailedDependencyError", async () => {
    // beforeEach already cleared ambient OPENAI_API_KEY/CODEX_API_KEY.
    // On platform-hosted pods there is no interactive `codex login`, so a
    // missing key is fatal.
    process.env.IS_PLATFORM = "true";

    await expect(
      prepareAgentEnv({ command: "codex-acp", args: [] }),
    ).rejects.toThrow("codex-acp requires an OpenAI/Codex API key");
  });

  test("LOCAL (non-platform) + no key from any route → does NOT throw, no OPENAI/CODEX vars forced", async () => {
    // beforeEach leaves IS_PLATFORM unset (local). A locally logged-in codex
    // CLI authenticates from its own stored OAuth state, so the spawn must be
    // allowed to proceed and we must NOT force any OPENAI_API_KEY/CODEX_API_KEY.
    const prepared = await prepareAgentEnv({ command: "codex-acp", args: [] });

    expect(prepared.env?.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.env?.CODEX_API_KEY).toBeUndefined();
  });

  test("LOCAL (non-platform) preserves unrelated agent.env without forcing codex keys", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OTHER_VAR: "keep-me" },
    });

    expect(prepared.env?.OTHER_VAR).toBe("keep-me");
    expect(prepared.env?.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.env?.CODEX_API_KEY).toBeUndefined();
  });

  test("a resolved credential injects BOTH vars regardless of platform (platform=true)", async () => {
    // A present credential short-circuits the platform-scoped missing-key
    // branch entirely: injection is identical on platform and local.
    process.env.IS_PLATFORM = "true";
    seedVaultOpenAiKey("vault-platform-key");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-platform-key");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-platform-key");
  });

  test("a resolved credential injects BOTH vars regardless of platform (local)", async () => {
    seedVaultOpenAiKey("vault-local-key");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-local-key");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-local-key");
  });

  test("gates on the resolved command BASENAME (alias to /custom/path/codex-acp still gets the key)", async () => {
    seedVaultOpenAiKey("vault-openai-FFF");

    const prepared = await prepareAgentEnv({
      command: "/opt/bin/codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-openai-FFF");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-openai-FFF");
  });

  test("does not affect claude-agent-acp spawns (claude unaffected)", async () => {
    seedVaultToken("vault-claude-only");
    seedVaultOpenAiKey("vault-openai-unused");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-claude-only");
    expect(prepared.env?.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.env?.CODEX_API_KEY).toBeUndefined();
  });
});

describe("prepareAgentEnv — non-claude commands", () => {
  test("returns the config unchanged for an unrecognized command basename", async () => {
    seedVaultToken("vault-HHH");

    const prepared = await prepareAgentEnv({
      command: "some-future-adapter",
      args: [],
      env: { FOO: "bar" },
    });

    expect(prepared.env).toEqual({ FOO: "bar" });
  });
});
