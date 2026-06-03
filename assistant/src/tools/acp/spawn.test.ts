import * as realChildProcess from "node:child_process";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";
import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type ExecCallback = (
  err: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

interface ExecScript {
  /** When set, the call rejects with this error. */
  error?: Error;
  /** When set, the call resolves with this stdout. */
  stdout?: string;
}

/**
 * Per-call scripted responses for `execFile`. Keyed by `${command} ${args[0]}`
 * so tests can target `npm ls` and `npm view` independently.
 */
const execScripts: Map<string, ExecScript> = new Map();

const execFileMock = mock(
  (
    command: string,
    args: string[],
    _options: unknown,
    callback?: ExecCallback,
  ) => {
    const key = `${command} ${args[0]}`;
    const script = execScripts.get(key);
    queueMicrotask(() => {
      if (!callback) return;
      if (!script) {
        callback(new Error(`No script for ${key}`), "", "");
        return;
      }
      if (script.error) {
        callback(script.error, "", "");
        return;
      }
      callback(null, script.stdout ?? "", "");
    });
    // Return value is not used by execFileWithTimeout.
    return {} as ReturnType<typeof realChildProcess.execFile>;
  },
);

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFile: execFileMock,
}));

// Default ACP config used by these tests: the `unknown-agent` entry is here
// to give the "no version check" test a configured agent whose binary isn't
// in DEFAULT_AGENT_NPM_PACKAGES.
const DEFAULT_TEST_AGENTS = {
  claude: { command: "claude-agent-acp", args: [] },
  codex: { command: "codex-acp", args: [] },
  "unknown-agent": { command: "some-other-binary", args: [] },
};

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub credential broker + metadata store so `prepareAgentEnv` can resolve
// tokens without the real OS keyring. Driven via `vaultStore` per test in
// beforeEach; the default seeds a vault token so existing tests (which assume
// claude spawns succeed) keep passing.
const vaultStore = new Map<string, string>();
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
        return { success: false, reason: `No stored value for ${key}` };
      }
      const result = await request.execute(value);
      return { success: true, result };
    },
  },
}));

// Stub session manager so we don't actually spawn child processes.
const spawnMock = mock(
  async (
    _agentId: string,
    _agentConfig: unknown,
    _task: string,
    _cwd: string,
    _parentConversationId: string,
    _sendToVellum: (msg: unknown) => void,
  ) => ({
    acpSessionId: "acp-session-test",
    protocolSessionId: "proto-session-test",
  }),
);

// Spread the real module's exports so transitive importers that pull other
// names from `../../acp/index.js` still resolve at parse time. Bun's `mock.module` is
// process-global and returns *exactly* the keys the factory returns —
// without the spread, any module evaluated after this test file errors at
// load with "Export named '<X>' not found".
const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({ spawn: spawnMock }),
}));

const { executeAcpSpawn, _resetAdapterVersionCacheForTests } =
  await import("./spawn.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    sendToClient: () => {},
  } as ToolContext;
}

beforeEach(() => {
  execScripts.clear();
  execFileMock.mockClear();
  spawnMock.mockClear();
  _resetAdapterVersionCacheForTests();
  config.setConfig({ agents: DEFAULT_TEST_AGENTS });
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
  // Default: vault has both a claude token and an OpenAI/Codex key so the
  // preflight in `prepareAgentEnv` succeeds for tests that don't care about
  // env injection (including codex-acp spawns). Env-injection tests below
  // clear/override this explicitly.
  vaultStore.clear();
  metadataStore.clear();
  vaultStore.set("acp/claude_oauth_token", "default-test-token");
  vaultStore.set("acp/openai_api_key", "default-test-openai-key");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeAcpSpawn — version check", () => {
  test("execFile failure: spawn proceeds without warning", async () => {
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("outdated");
    expect(result.content).not.toContain("Note:");
    // Spawn was actually invoked.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Sanity: payload shape preserved.
    const lines = result.content.split("\n\n");
    const payload = JSON.parse(lines[0]);
    expect(payload.acpSessionId).toBe("acp-session-test");
    expect(payload.status).toBe("running");
  });

  test("outdated version: spawn proceeds AND warning appears in content", async () => {
    execScripts.set("npm ls", {
      stdout: JSON.stringify({
        dependencies: {
          "@agentclientprotocol/claude-agent-acp": { version: "0.1.0" },
        },
      }),
    });
    execScripts.set("npm view", { stdout: "0.2.0\n" });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("outdated");
    expect(result.content).toContain("@agentclientprotocol/claude-agent-acp");
    expect(result.content).toContain("0.1.0");
    expect(result.content).toContain("0.2.0");
    expect(result.content).toContain(
      "npm install -g @agentclientprotocol/claude-agent-acp@0.2.0",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Payload still parses as JSON before the warning suffix.
    const [payloadJson] = result.content.split("\n\n");
    const payload = JSON.parse(payloadJson);
    expect(payload.acpSessionId).toBe("acp-session-test");
  });

  test("up-to-date version: spawn proceeds, no warning", async () => {
    execScripts.set("npm ls", {
      stdout: JSON.stringify({
        dependencies: {
          "@agentclientprotocol/claude-agent-acp": { version: "0.2.0" },
        },
      }),
    });
    execScripts.set("npm view", { stdout: "0.2.0\n" });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("outdated");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("unknown command: no version check is performed", async () => {
    // No execScripts set — if the implementation tried to run npm, the
    // mock would callback with "No script for ..." and we could detect
    // the failure. But since the registry doesn't include this command,
    // the implementation should skip the check entirely without calling
    // execFile.
    execFileMock.mockClear();

    const result = await executeAcpSpawn(
      { agent: "unknown-agent", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // No outdated note suffix.
    expect(result.content).not.toContain("outdated");
  });

  test("cached null result: second call does not reprobe", async () => {
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    await executeAcpSpawn({ agent: "claude", task: "task 1" }, makeContext());
    const firstCallCount = execFileMock.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await executeAcpSpawn({ agent: "claude", task: "task 2" }, makeContext());
    // No additional execFile calls — result was cached.
    expect(execFileMock.mock.calls.length).toBe(firstCallCount);
  });

  test("cached outdated result: second call does not reprobe but still warns", async () => {
    execScripts.set("npm ls", {
      stdout: JSON.stringify({
        dependencies: {
          "@agentclientprotocol/claude-agent-acp": { version: "0.1.0" },
        },
      }),
    });
    execScripts.set("npm view", { stdout: "0.2.0\n" });

    const first = await executeAcpSpawn(
      { agent: "claude", task: "task 1" },
      makeContext(),
    );
    expect(first.content).toContain("outdated");
    const firstCallCount = execFileMock.mock.calls.length;

    const second = await executeAcpSpawn(
      { agent: "claude", task: "task 2" },
      makeContext(),
    );
    expect(second.content).toContain("outdated");
    // No additional execFile calls — outdated info was cached.
    expect(execFileMock.mock.calls.length).toBe(firstCallCount);
  });
});

describe("executeAcpSpawn — input validation", () => {
  test("missing task returns error", async () => {
    const result = await executeAcpSpawn({ agent: "claude" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task");
  });

  test("missing sendToClient returns error", async () => {
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      { ...makeContext(), sendToClient: undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No client connected");
  });

  test("unknown agent in config returns error", async () => {
    const result = await executeAcpSpawn(
      { agent: "nonexistent", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown agent "nonexistent"');
    // New error message lists the merged catalog (defaults + user agents).
    expect(result.content).toContain("Available:");
  });

  test("acp disabled returns error with config hint", async () => {
    config.setConfig({ enabled: false, agents: DEFAULT_TEST_AGENTS });
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("acp.enabled");
  });

  test("missing binary returns install hint", async () => {
    which.setWhich({});
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("claude-agent-acp is not on PATH");
    expect(result.content).toContain(
      "npm i -g @agentclientprotocol/claude-agent-acp",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("default-profile fallback when user config is empty", async () => {
    // No user `agents.codex` entry, but `agent: "codex"` works via the bundled
    // default profile (command: "codex-acp"). The resolver merges defaults
    // automatically.
    config.setConfig({ agents: {} });
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "codex", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The agentConfig handed to spawn() should be the bundled default.
    const agentConfigArg = spawnMock.mock.calls[0][1] as { command: string };
    expect(agentConfigArg.command).toBe("codex-acp");
  });
});

describe("executeAcpSpawn — per-agent resume hint", () => {
  test("claude payload includes the `claude --resume` hint", async () => {
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const [payloadJson] = result.content.split("\n\n");
    const payload = JSON.parse(payloadJson);
    expect(payload.message).toContain("claude --resume");
    expect(payload.message).toContain("To resume this session later");
  });

  test("non-claude payload omits the `claude --resume` hint", async () => {
    // `claude --resume <id>` is Claude Code-specific. Codex (and any other
    // adapter) should not have that command suggested back to the user.
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "codex", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const [payloadJson] = result.content.split("\n\n");
    const payload = JSON.parse(payloadJson);
    expect(payload.message).not.toContain("claude --resume");
    expect(payload.message).not.toContain("To resume this session later");
  });
});

// ---------------------------------------------------------------------------
// executeAcpSpawn — CLAUDE_CODE_OAUTH_TOKEN env injection + preflight
//
// Mirrors the HTTP-route test block in
// `runtime/routes/acp-routes.test.ts` — the skill tool calls into the same
// `prepareAgentEnv` helper, and the contract must be identical so a
// missing token fails the spawn at the tool boundary (`isError: true`)
// instead of letting a token-less subprocess zombie out. PR-history
// context: the inline env-injection used to live in the route only; this
// tool path was bypassing it entirely, causing every skill-driven ACP
// spawn to die on first prompt with "Authentication required". Pin both
// the happy paths and the throw path here so future drift on either
// caller fails the suite loudly.
// ---------------------------------------------------------------------------

describe("executeAcpSpawn — CLAUDE_CODE_OAUTH_TOKEN injection", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the vault via the broker for the claude agent", async () => {
    vaultStore.clear();
    metadataStore.clear();
    vaultStore.set("acp/claude_oauth_token", "tool-vault-token-abc");
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const agentConfigArg = spawnMock.mock.calls[0][1] as {
      env?: Record<string, string>;
    };
    expect(agentConfigArg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "tool-vault-token-abc",
    );
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from config.json agent.env without a vault entry", async () => {
    vaultStore.clear();
    metadataStore.clear();
    config.setConfig({
      agents: {
        claude: {
          command: "claude-agent-acp",
          args: [],
          env: { CLAUDE_CODE_OAUTH_TOKEN: "tool-config-token-xyz" },
        },
        codex: { command: "codex-acp", args: [] },
        "unknown-agent": { command: "some-other-binary", args: [] },
      },
    });
    execScripts.set("npm ls", { error: new Error("npm not installed") });
    execScripts.set("npm view", { error: new Error("npm not installed") });

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const agentConfigArg = spawnMock.mock.calls[0][1] as {
      env?: Record<string, string>;
    };
    expect(agentConfigArg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "tool-config-token-xyz",
    );
  });

  test("returns isError when no token is available from either route (preflight throw mapped to tool result)", async () => {
    vaultStore.clear();
    metadataStore.clear();

    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
