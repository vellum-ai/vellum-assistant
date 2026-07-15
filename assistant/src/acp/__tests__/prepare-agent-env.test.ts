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

import { FailedDependencyError } from "../../runtime/routes/errors.js";

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
      usageDescription: policy?.usageDescription ?? existing?.usageDescription,
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

const { prepareAgentEnv, ACP_CLAUDE_OAUTH_MISSING_CODE } =
  await import("../prepare-agent-env.js");

beforeEach(() => {
  metadataStore.clear();
  vaultStore.clear();
});

// ---------------------------------------------------------------------------
// Helper to seed a vault entry (simulates `assistant credentials set`).
// ---------------------------------------------------------------------------

function seedVaultToken(token: string): void {
  vaultStore.set("acp/claude_oauth_token", token);
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

  test("enriches the missing-token error with the acp_claude_oauth_missing marker AND keeps the CLI message", async () => {
    let caught: unknown;
    try {
      await prepareAgentEnv({ command: "claude-agent-acp", args: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FailedDependencyError);
    // Structured marker survives as `details` for the client to branch on.
    expect((caught as FailedDependencyError).details).toEqual({
      code: ACP_CLAUDE_OAUTH_MISSING_CODE,
    });
    // Human, CLI-friendly message is not lost.
    expect((caught as Error).message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("does NOT attach the marker when a token is present (happy path unchanged)", async () => {
    seedVaultToken("vault-marker-absent");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-marker-absent");
  });

  test("gates on the resolved command BASENAME (alias to /custom/path/claude-agent-acp still gets the token)", async () => {
    seedVaultToken("vault-FFF");

    const prepared = await prepareAgentEnv({
      command: "/opt/bin/claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-FFF");
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

describe("prepareAgentEnv - codex-acp gating", () => {
  function seedVaultOpenaiKey(key: string): void {
    vaultStore.set("acp/openai_api_key", key);
  }

  function seedVaultCodexKey(key: string): void {
    vaultStore.set("acp/codex_api_key", key);
  }

  test("injects OPENAI_API_KEY from the vault via the broker when agent.env has no override", async () => {
    seedVaultOpenaiKey("vault-fake-openai-AAA");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-AAA");
  });

  test("agent.env override wins over the vault entry and skips the broker (precedence pin)", async () => {
    // Seed a vault value but no metadata: if the override path consulted the
    // broker anyway, ensureAcpCredentialPolicy would create metadata here.
    seedVaultOpenaiKey("vault-fake-openai-BBB");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OPENAI_API_KEY: "config-fake-openai-CCC" },
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("config-fake-openai-CCC");
    expect(metadataStore.has("acp/openai_api_key")).toBe(false);
  });

  test("a vault miss for both fields does NOT throw and spawns with env unchanged (keys are optional)", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { NO_COLOR: "1" },
    });

    expect(prepared.env).toEqual({ NO_COLOR: "1" });
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(prepared.env).not.toHaveProperty("CODEX_API_KEY");
  });

  test("injects CODEX_API_KEY independently of OPENAI_API_KEY", async () => {
    seedVaultCodexKey("vault-fake-codex-DDD");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.CODEX_API_KEY).toBe("vault-fake-codex-DDD");
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("injects both keys when both vault fields are present", async () => {
    seedVaultOpenaiKey("vault-fake-openai-EEE");
    seedVaultCodexKey("vault-fake-codex-FFF");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-EEE");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-fake-codex-FFF");
  });

  test("gates on the resolved command BASENAME (custom agent id with full path still gets injection)", async () => {
    seedVaultOpenaiKey("vault-fake-openai-GGG");

    const prepared = await prepareAgentEnv({
      command: "/data/.bun/bin/codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-GGG");
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
