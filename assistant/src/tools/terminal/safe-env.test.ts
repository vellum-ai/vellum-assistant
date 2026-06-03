/**
 * Tests for the ACP agent spawn environment.
 *
 * The spawned agent runs in the user's own pod and is treated as untrusted
 * code, so it must receive only the shared safe-env allowlist (PATH +
 * allowlisted vars) plus its own injected ACP/git credentials — never the
 * daemon's platform secrets (`CES_SERVICE_TOKEN`, `ACTOR_TOKEN_SIGNING_KEY`)
 * and never the internal control-plane reachability vars (the internal gateway
 * URL, CES daemon endpoints, in-pod IPC sockets) that would let the untrusted
 * agent reach the tokenless-loopback gateway control plane.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildAgentSpawnEnv } from "./safe-env.js";

describe("buildAgentSpawnEnv", () => {
  const saved: Record<string, string | undefined> = {};
  // Internal control-plane reachability vars that must be stripped from the
  // untrusted ACP agent's spawn env. INTERNAL_GATEWAY_BASE_URL is always
  // injected by buildSanitizedEnv(); the rest are allowlist pass-throughs.
  const CONTROL_PLANE_VARS = [
    "GATEWAY_INTERNAL_URL",
    "CES_CREDENTIAL_URL",
    "CES_BOOTSTRAP_SOCKET_DIR",
    "ASSISTANT_IPC_SOCKET_DIR",
    "ASSISTANT_SKILL_IPC_SOCKET_DIR",
    "GATEWAY_IPC_SOCKET_DIR",
    "GATEWAY_SECURITY_DIR",
  ];
  const TOUCHED = [
    "PATH",
    "HOME",
    "CES_SERVICE_TOKEN",
    "ACTOR_TOKEN_SIGNING_KEY",
    "INTERNAL_GATEWAY_BASE_URL",
    ...CONTROL_PLANE_VARS,
  ];

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    process.env.HOME = "/home/agent";
    process.env.CES_SERVICE_TOKEN = "daemon-service-token";
    process.env.ACTOR_TOKEN_SIGNING_KEY = "f".repeat(64);
    // Stub the internal control-plane vars so we can assert they are stripped.
    // INTERNAL_GATEWAY_BASE_URL is injected by buildSanitizedEnv() regardless,
    // but we set GATEWAY_INTERNAL_URL so that injection resolves to it.
    process.env.GATEWAY_INTERNAL_URL = "http://gateway:7822";
    process.env.CES_CREDENTIAL_URL = "http://127.0.0.1:7900/credentials";
    process.env.CES_BOOTSTRAP_SOCKET_DIR = "/run/ces-bootstrap";
    process.env.ASSISTANT_IPC_SOCKET_DIR = "/run/assistant-ipc";
    process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = "/run/skill-ipc";
    process.env.GATEWAY_IPC_SOCKET_DIR = "/run/gateway-ipc";
    process.env.GATEWAY_SECURITY_DIR = "/run/gateway-security";
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

  test("strips internal control-plane reachability vars from the agent env", () => {
    const env = buildAgentSpawnEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-abc",
    });

    // The internal gateway URL (the tokenless-loopback control plane) must not
    // leak to the untrusted agent — even though buildSanitizedEnv() injects it.
    expect(env.INTERNAL_GATEWAY_BASE_URL).toBeUndefined();
    // Sibling internal gateway / CES daemon / IPC-socket vars are stripped too.
    for (const key of CONTROL_PLANE_VARS) {
      expect(env[key]).toBeUndefined();
    }
    // Injected creds still land — the agent reaches services via its own creds.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-abc");
    // PATH is still preserved so ACP adapter binaries resolve.
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
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
