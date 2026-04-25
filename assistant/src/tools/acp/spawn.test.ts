import * as realChildProcess from "node:child_process";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

// Mock config so getConfig() returns enabled ACP with our test agents. The
// resolver consumes this same loader, so updates here are visible to it.
interface MockConfig {
  acp: {
    enabled: boolean;
    maxConcurrentSessions: number;
    agents: Record<string, { command: string; args: string[] }>;
  };
}

const defaultMockConfig: MockConfig = {
  acp: {
    enabled: true,
    maxConcurrentSessions: 5,
    agents: {
      claude: { command: "claude-agent-acp", args: [] },
      codex: { command: "codex-acp", args: [] },
      "unknown-agent": { command: "some-other-binary", args: [] },
    },
  },
};

let mockConfig: MockConfig = structuredClone(defaultMockConfig);

mock.module("../../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

// Swap Bun.which with a stub so the resolver's PATH preflight is deterministic
// regardless of the host environment. By default every command resolves; tests
// override `whichStub` to simulate a missing binary.
const originalWhich = Bun.which;
let whichStub: (command: string) => string | null = (cmd) =>
  `/usr/local/bin/${cmd}`;
(Bun as unknown as { which: (cmd: string) => string | null }).which = (cmd) =>
  whichStub(cmd);

afterAll(() => {
  (Bun as unknown as { which: typeof originalWhich }).which = originalWhich;
});

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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

mock.module("../../acp/index.js", () => ({
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
  mockConfig = structuredClone(defaultMockConfig);
  whichStub = (cmd) => `/usr/local/bin/${cmd}`;
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
    mockConfig.acp.enabled = false;
    const result = await executeAcpSpawn(
      { agent: "claude", task: "do something" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("acp.enabled");
  });

  test("missing binary returns install hint", async () => {
    whichStub = () => null;
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
    mockConfig.acp.agents = {};
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
