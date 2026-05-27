/**
 * Tests for `prepareAgentEnv` — the shared helper that injects required env
 * vars onto an `AcpAgentConfig` and preflights that they're set.
 *
 * The route-level test in `runtime/routes/acp-routes.test.ts` covers the same
 * behavior through the HTTP handler; these tests pin the helper in isolation
 * so the contract is clear and a future refactor can't silently break it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the secure-keys backend BEFORE importing the helper. Bun's
// `mock.module` is process-global and only takes effect for imports that
// follow it — the dynamic import below ensures correctness.
const secureKeyStore = new Map<string, string>();

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeyStore.get(key),
}));

const { prepareAgentEnv } = await import("../prepare-agent-env.js");

beforeEach(() => {
  secureKeyStore.clear();
});

describe("prepareAgentEnv — claude-agent-acp gating", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the secure store when agent.env has no override", async () => {
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-AAA");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-AAA");
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-BBB" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-BBB");
  });

  test("agent.env override wins over the secure-store entry (precedence pin)", async () => {
    // The config-supplied env wins so users can rotate per-workspace without
    // racing the vault. Mirrors the route-level precedence test.
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-CCC");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-DDD" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-DDD");
  });

  test("preserves unrelated env vars on agent.env when injecting from the vault", async () => {
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-EEE");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { OTHER_VAR: "keep-me" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-EEE");
    expect(prepared.env?.OTHER_VAR).toBe("keep-me");
  });

  test("throws FailedDependencyError when no token is provided from either route", async () => {
    // secureKeyStore empty, no agent.env override — the preflight must throw
    // so callers fail fast instead of spawning a zombie subprocess that the
    // SDK rejects with 'Authentication required' after the first prompt.
    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("gates on the resolved command BASENAME (alias to /custom/path/claude-agent-acp still gets the token)", async () => {
    // A user-supplied `acp.agents.my-claude = { command: "/opt/.../claude-agent-acp" }`
    // is the only realistic path that lands a non-bare basename here. The
    // helper must still recognize it.
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-FFF");

    const prepared = await prepareAgentEnv({
      command: "/opt/bin/claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-FFF");
  });

  test("does NOT mutate the caller's agentConfig", async () => {
    // Callers pass `resolved.agent` which is shared state from the resolver's
    // config cache. The helper must clone before mutating, otherwise repeated
    // spawns would race on the same object.
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-GGG");
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
    // codex-acp inherits auth from the underlying `codex` CLI binary
    // (codex login / CODEX_API_KEY / OPENAI_API_KEY in process.env) — no
    // ACP-level env injection. Pin that contract so a future change has
    // to update this test explicitly.
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env).toEqual({});
  });

  test("returns the config unchanged for an unrecognized command basename", async () => {
    secureKeyStore.set("credential/acp/claude_oauth_token", "vault-HHH");

    const prepared = await prepareAgentEnv({
      command: "some-future-adapter",
      args: [],
      env: { FOO: "bar" },
    });

    // No injection — basename gate skipped.
    expect(prepared.env).toEqual({ FOO: "bar" });
  });
});
