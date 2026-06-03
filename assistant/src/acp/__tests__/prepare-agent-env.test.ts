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

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
        return {
          success: false,
          reason: `No stored value for ${key}`,
        };
      }
      const result = await request.execute(value);
      return { success: true, result };
    },
  },
}));

const { prepareAgentEnv } = await import("../prepare-agent-env.js");

beforeEach(() => {
  metadataStore.clear();
  vaultStore.clear();
  // Ambient daemon-level creds are an explicit fallback source; clear them so
  // a value leaking in from the test runner's own env can't mask precedence.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Helper to seed a vault entry (simulates `assistant credentials set`).
// ---------------------------------------------------------------------------

function seedVaultToken(token: string): void {
  vaultStore.set("acp/claude_oauth_token", token);
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

  test("falls back to ambient process.env.ANTHROPIC_API_KEY when neither agent.env nor the vault has a credential", async () => {
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.ANTHROPIC_API_KEY).toBe("ambient-anthropic");
    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("falls back to ambient process.env.CLAUDE_CODE_OAUTH_TOKEN, preferred over an ambient API key", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic";

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-oauth");
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

describe("prepareAgentEnv — non-claude commands", () => {
  test("returns the config unchanged for codex-acp (no required env vars today)", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env).toEqual({});
  });

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
