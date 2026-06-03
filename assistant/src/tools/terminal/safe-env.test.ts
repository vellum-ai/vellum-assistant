/**
 * Tests for the ACP agent spawn environment.
 *
 * The spawned agent runs in the user's own pod and is treated as untrusted
 * code, so it must receive only the shared safe-env allowlist (PATH +
 * allowlisted vars) plus its own injected ACP/git credentials — never the
 * daemon's platform secrets (`CES_SERVICE_TOKEN`, `ACTOR_TOKEN_SIGNING_KEY`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildAgentSpawnEnv } from "./safe-env.js";

describe("buildAgentSpawnEnv", () => {
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = [
    "PATH",
    "HOME",
    "CES_SERVICE_TOKEN",
    "ACTOR_TOKEN_SIGNING_KEY",
  ];

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    process.env.HOME = "/home/agent";
    process.env.CES_SERVICE_TOKEN = "daemon-service-token";
    process.env.ACTOR_TOKEN_SIGNING_KEY = "f".repeat(64);
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("includes PATH and allowlisted vars, plus injected creds applied last", () => {
    const env = buildAgentSpawnEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-abc",
      GIT_ASKPASS: "/usr/local/bin/git-askpass",
    });

    // PATH preserved so the ACP adapter binaries resolve.
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    // Other allowlisted vars pass through.
    expect(env.HOME).toBe("/home/agent");
    // Injected ACP/git credentials land (applied last).
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-abc");
    expect(env.GIT_ASKPASS).toBe("/usr/local/bin/git-askpass");
  });

  test("strips daemon/platform secrets from the inherited env", () => {
    const env = buildAgentSpawnEnv();

    expect(env.CES_SERVICE_TOKEN).toBeUndefined();
    expect(env.ACTOR_TOKEN_SIGNING_KEY).toBeUndefined();
  });

  test("works with no injected env", () => {
    const env = buildAgentSpawnEnv();

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.CES_SERVICE_TOKEN).toBeUndefined();
  });

  test("injected env overrides allowlist base for the same key", () => {
    const env = buildAgentSpawnEnv({ HOME: "/workspace" });

    expect(env.HOME).toBe("/workspace");
  });

  test("a CES_SERVICE_TOKEN supplied via injected env is still honored", () => {
    // Stripping targets the inherited daemon secret, not deliberately
    // injected credentials. Injected env wins because it is applied last.
    const env = buildAgentSpawnEnv({ CES_SERVICE_TOKEN: "agent-scoped-token" });

    expect(env.CES_SERVICE_TOKEN).toBe("agent-scoped-token");
  });
});
