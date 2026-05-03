import * as realChildProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Capture the real spawn before mock.module replaces it
const originalSpawn = realChildProcess.spawn;

// Capture spawn calls to verify the host tool spawns 'bash' directly
const spawnCalls: { command: string; args: string[] }[] = [];
const spawnSpy = mock((...args: Parameters<typeof realChildProcess.spawn>) => {
  spawnCalls.push({ command: args[0] as string, args: args[1] as string[] });
  return (originalSpawn as (...a: unknown[]) => unknown)(...args);
});

mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: spawnSpy,
}));

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: true,
  },
  auditLog: { retentionDays: 0 },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock the host-bash-proxy singleton so proxy delegation tests can control it.
let mockProxyAvailable = false;
let mockProxyRequestFn: (
  input: { command: string; working_dir?: string; timeout_seconds?: number; env?: Record<string, string>; targetClientId?: string },
  conversationId: string,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult> = () =>
  Promise.resolve({ content: "", isError: false });

mock.module("../daemon/host-bash-proxy.js", () => ({
  HostBashProxy: {
    get instance() {
      return {
        isAvailable: () => mockProxyAvailable,
        request: mockProxyRequestFn,
      };
    },
  },
}));

import { hostShellTool } from "../tools/host-terminal/host-shell.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

const testDirs: string[] = [];

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mockProxyAvailable = false;
  mockProxyRequestFn = () => Promise.resolve({ content: "", isError: false });
});

describe("host_bash tool", () => {
  test("rejects relative working_dir", async () => {
    const result = await hostShellTool.execute(
      {
        command: "pwd",
        working_dir: "relative/path",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("working_dir must be absolute");
  });

  test("executes command in provided absolute working_dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-test-"));
    testDirs.push(dir);

    const result = await hostShellTool.execute(
      {
        command: "pwd",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe(realpathSync(dir));
  });

  test("returns error for non-zero exit commands", async () => {
    const result = await hostShellTool.execute(
      { command: "exit 12" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('<command_exit code="12" />');
  });

  test("does not route through sandbox wrapCommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-nosandbox-"));
    testDirs.push(dir);

    const result = await hostShellTool.execute(
      {
        command: "echo isolation-test",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("isolation-test");
  });

  test("spawns plain bash without sandbox-exec or bwrap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-plain-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute(
      {
        command: "echo hello",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // Verify spawn was called with 'bash' directly — not 'bwrap' or 'sandbox-exec'
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe("bash");
    expect(spawnCalls[0].args).toEqual(["-c", "--", "echo hello"]);
  });
});

// ---------------------------------------------------------------------------
// Baseline: host_bash bypasses all sandbox wrappers
// ---------------------------------------------------------------------------

describe("host_bash — baseline: no sandbox isolation", () => {
  test('does not use Docker wrapper (no "docker" as spawn command)', async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-no-docker-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute(
      {
        command: "echo baseline",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // The spawn command must be 'bash', never 'docker'
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe("bash");
    expect(spawnCalls[0].command).not.toBe("docker");
  });

  test("does not use sandbox-exec or bwrap wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-no-native-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute(
      {
        command: "echo no-native-sandbox",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnCalls[0].command).not.toBe("sandbox-exec");
    expect(spawnCalls[0].command).not.toBe("bwrap");
  });

  test("runs directly with bash -c -- <command> args format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-args-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    await hostShellTool.execute(
      {
        command: "ls -la /tmp",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(spawnCalls[0].command).toBe("bash");
    expect(spawnCalls[0].args[0]).toBe("-c");
    expect(spawnCalls[0].args[1]).toBe("--");
    expect(spawnCalls[0].args[2]).toBe("ls -la /tmp");
  });

  test("host_bash always spawns plain bash without wrapCommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-sandbox-cfg-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute(
      {
        command: "echo sandbox-enabled-irrelevant",
        working_dir: dir,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(spawnCalls[0].command).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// Regression: host_bash must NOT gain proxied-mode properties
// ---------------------------------------------------------------------------
// The sandboxed `bash` tool gained `network_mode` and `credential_ids` in
// the media-reuse rollout (PR 13). The `host_bash` tool must never acquire
// these — it runs unsandboxed on the host and has no proxy infrastructure.
// These tests lock that boundary so any accidental addition is caught.

describe("host_bash — regression: no proxied-mode additions", () => {
  const definition = hostShellTool.getDefinition();
  const schemaProps = (definition.input_schema as Record<string, unknown>)
    .properties as Record<string, unknown>;

  test("schema does not include network_mode property", () => {
    expect(schemaProps).not.toHaveProperty("network_mode");
  });

  test("schema does not include credential_ids property", () => {
    expect(schemaProps).not.toHaveProperty("credential_ids");
  });

  test("schema only contains the expected properties (command, working_dir, timeout_seconds, activity, background, target_client_id)", () => {
    const propertyNames = Object.keys(schemaProps).sort();
    expect(propertyNames).toEqual([
      "activity",
      "background",
      "command",
      "target_client_id",
      "timeout_seconds",
      "working_dir",
    ]);
  });

  test("execute ignores network_mode even if supplied in input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-ignore-network-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    // Pass network_mode as if the model hallucinated the parameter —
    // host_bash must ignore it and run the command normally.
    const result = await hostShellTool.execute(
      {
        command: "echo should-work",
        working_dir: dir,
        network_mode: "proxied",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("should-work");
    // Must still spawn plain bash, not anything proxy-related
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe("bash");
    // Must never route through sandbox wrapCommand, even with proxied-mode input
  });

  test("execute ignores credential_ids even if supplied in input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-ignore-creds-"));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute(
      {
        command: "echo creds-ignored",
        working_dir: dir,
        credential_ids: ["gmail-oauth", "github-token"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("creds-ignored");
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe("bash");
    // Must never route through sandbox wrapCommand, even with credential inputs
  });

  test("tool name is host_bash (not bash)", () => {
    expect(definition.name).toBe("host_bash");
  });

  test("required fields contains command and activity", () => {
    expect(
      (definition.input_schema as Record<string, unknown>).required,
    ).toEqual(["command", "activity"]);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("host_bash — input validation", () => {
  test("rejects null bytes in command", async () => {
    const result = await hostShellTool.execute(
      {
        command: "echo \0evil",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("null bytes");
  });

  test("rejects null bytes in working_dir", async () => {
    const result = await hostShellTool.execute(
      {
        command: "echo test",
        working_dir: "/tmp/\0evil",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("null bytes");
  });

  test("rejects empty command", async () => {
    const result = await hostShellTool.execute(
      {
        command: "",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  test("rejects non-string command", async () => {
    const result = await hostShellTool.execute(
      {
        command: 42,
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "command is required and must be a string",
    );
  });

  test("rejects non-string working_dir", async () => {
    const result = await hostShellTool.execute(
      {
        command: "echo test",
        working_dir: 123,
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("working_dir must be a string");
  });
});

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

describe("host_bash — environment setup", () => {
  test("defaults working_dir to user home when not provided", async () => {
    const { homedir } = await import("node:os");
    const result = await hostShellTool.execute(
      {
        command: "pwd",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe(realpathSync(homedir()));
  });

  test("PATH includes ~/.local/bin and ~/.bun/bin", async () => {
    const { homedir } = await import("node:os");
    const home = homedir();

    const result = await hostShellTool.execute(
      {
        command: 'echo "$PATH"',
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`${home}/.local/bin`);
    expect(result.content).toContain(`${home}/.bun/bin`);
  });

  test("does not leak non-allowlisted env vars", async () => {
    // Set a custom env var that is NOT in the SAFE_ENV_VARS allowlist
    const varName = "VELLUM_TEST_UNLISTED_VAR";
    const originalVal = process.env[varName];
    process.env[varName] = "should-not-appear";

    try {
      const result = await hostShellTool.execute(
        {
          command: "env",
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).not.toContain(varName);
      expect(result.content).not.toContain("should-not-appear");
    } finally {
      if (originalVal === undefined) {
        delete process.env[varName];
      } else {
        process.env[varName] = originalVal;
      }
    }
  });

  test("includes safe env vars like HOME and TERM", async () => {
    const result = await hostShellTool.execute(
      {
        command: 'echo "HOME=$HOME"',
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("HOME=");
    expect(result.content.trim()).not.toBe("HOME=");
  });

  test("injects INTERNAL_GATEWAY_BASE_URL for host_bash commands", async () => {
    const originalGatewayPort = process.env.GATEWAY_PORT;
    process.env.GATEWAY_PORT = "9000";
    try {
      const result = await hostShellTool.execute(
        {
          command: 'echo "$INTERNAL_GATEWAY_BASE_URL"',
        },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      expect(result.content.trim()).toBe("http://127.0.0.1:9000");
    } finally {
      if (originalGatewayPort === undefined) {
        delete process.env.GATEWAY_PORT;
      } else {
        process.env.GATEWAY_PORT = originalGatewayPort;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("host_bash — timeout handling", () => {
  test("respects custom timeout_seconds", async () => {
    const result = await hostShellTool.execute(
      {
        command: "sleep 5",
        timeout_seconds: 1,
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("command_timeout");
  });

  test("clamps timeout to at least 1 second", async () => {
    // A timeout_seconds of 0 should be clamped to 1
    const result = await hostShellTool.execute(
      {
        command: "echo fast",
        timeout_seconds: 0,
      },
      makeContext(),
    );

    // Should still complete — 1 second is enough for echo
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("fast");
  });

  test("clamps timeout to max configured value", async () => {
    // Request a timeout larger than the configured max (600)
    const result = await hostShellTool.execute(
      {
        command: "echo capped",
        timeout_seconds: 9999,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("capped");
  });
});

// ---------------------------------------------------------------------------
// Streaming output and abort signal
// ---------------------------------------------------------------------------

describe("host_bash — streaming and cancellation", () => {
  test("calls onOutput callback with stdout chunks", async () => {
    const chunks: string[] = [];
    const ctx = {
      ...makeContext(),
      onOutput: (chunk: string) => chunks.push(chunk),
    };

    const result = await hostShellTool.execute(
      {
        command: "echo streamed-output",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(chunks.join("")).toContain("streamed-output");
  });

  test("calls onOutput callback with stderr chunks", async () => {
    const chunks: string[] = [];
    const ctx = {
      ...makeContext(),
      onOutput: (chunk: string) => chunks.push(chunk),
    };

    await hostShellTool.execute(
      {
        command: "echo stderr-data >&2",
      },
      ctx,
    );

    expect(chunks.join("")).toContain("stderr-data");
  });

  test("kills process when abort signal fires", async () => {
    const ac = new AbortController();

    // Start a long-running command then abort it quickly
    const promise = hostShellTool.execute(
      {
        command: "sleep 30",
      },
      { ...makeContext(), signal: ac.signal },
    );

    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const result = await promise;
    // The process was killed, so it should report an error (non-zero exit)
    expect(result.isError).toBe(true);
  });

  test("immediately kills process if signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await hostShellTool.execute(
      {
        command: "sleep 30",
      },
      { ...makeContext(), signal: ac.signal },
    );

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling for spawn failures
// ---------------------------------------------------------------------------

describe("host_bash — spawn error handling", () => {
  test("reports error when working_dir does not exist", async () => {
    const result = await hostShellTool.execute(
      {
        command: "echo test",
        working_dir: "/nonexistent/path/that/does/not/exist",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error spawning command");
  });

  test("captures both stdout and stderr in output", async () => {
    const result = await hostShellTool.execute(
      {
        command: "echo out && echo err >&2",
      },
      makeContext(),
    );

    expect(result.content).toContain("out");
    expect(result.content).toContain("err");
  });

  test("returns completed marker for successful empty output", async () => {
    const result = await hostShellTool.execute(
      {
        command: "true",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("<command_completed />");
  });

  test("injects __CONVERSATION_ID for local host_bash execution", async () => {
    const result = await hostShellTool.execute(
      {
        command: 'echo "$__CONVERSATION_ID"',
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("test-conversation");
  });
});

// ---------------------------------------------------------------------------
// HostBashProxy delegation
// ---------------------------------------------------------------------------

describe("host_bash — proxy delegation", () => {
  const ROUTING_ENV_KEYS = [
    "VELLUM_WORKSPACE_DIR",
    "VELLUM_DATA_DIR",
    "VELLUM_ENVIRONMENT",
    "INTERNAL_GATEWAY_BASE_URL",
  ] as const;

  function captureEnv(
    keys: readonly string[],
  ): Record<string, string | undefined> {
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keys) {
      snapshot[key] = process.env[key];
    }
    return snapshot;
  }

  function restoreEnv(snapshot: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function setupMockProxy(result: ToolExecutionResult) {
    const calls: Array<{
      input: {
        command: string;
        working_dir?: string;
        timeout_seconds?: number;
        env?: Record<string, string>;
        targetClientId?: string;
      };
      conversationId: string;
    }> = [];

    mockProxyAvailable = true;
    mockProxyRequestFn = async (input, conversationId) => {
      calls.push({ input, conversationId });
      return result;
    };

    return calls;
  }

  test("delegates to proxy when proxy is available", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxied output",
      isError: false,
    };
    const calls = setupMockProxy(proxyResult);

    const ctx: ToolContext = {
      ...makeContext(),
    };

    spawnCalls.length = 0;
    const result = await hostShellTool.execute(
      { command: "echo hello", working_dir: "/tmp", timeout_seconds: 30 },
      ctx,
    );

    expect(result).toBe(proxyResult);
    expect(calls.length).toBe(1);
    expect(calls[0].input.command).toBe("echo hello");
    expect(calls[0].input.working_dir).toBe("/tmp");
    expect(calls[0].input.timeout_seconds).toBe(30);
    expect(calls[0].conversationId).toBe("test-conversation");
    // Should NOT have spawned a local process
    expect(spawnCalls.length).toBe(0);
  });

  test("still validates input before proxying (null bytes in command)", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxied",
      isError: false,
    };
    const calls = setupMockProxy(proxyResult);

    const ctx: ToolContext = {
      ...makeContext(),
    };

    const result = await hostShellTool.execute({ command: "echo \0evil" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("null bytes");
    // Proxy should NOT have been called
    expect(calls.length).toBe(0);
  });

  test("still validates input before proxying (relative working_dir)", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxied",
      isError: false,
    };
    const calls = setupMockProxy(proxyResult);

    const ctx: ToolContext = {
      ...makeContext(),
    };

    const result = await hostShellTool.execute(
      { command: "echo test", working_dir: "relative/path" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("working_dir must be absolute");
    expect(calls.length).toBe(0);
  });

  test("falls back to local execution when proxy is not available", async () => {
    // mockProxyAvailable defaults to false, so isAvailable() returns false
    const dir = mkdtempSync(join(tmpdir(), "host-shell-proxy-fallback-"));
    testDirs.push(dir);

    const ctx: ToolContext = {
      ...makeContext(),
    };

    spawnCalls.length = 0;
    const result = await hostShellTool.execute(
      { command: "echo local-fallback", working_dir: dir },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("local-fallback");
    // Should have spawned locally
    expect(spawnCalls.length).toBe(1);
  });

  test("returns error when explicit targetClientId is set but proxy is unavailable (client disconnected)", async () => {
    // mockProxyAvailable defaults to false — simulates client disconnecting
    // after tool definitions were built (targetClientId already resolved).
    spawnCalls.length = 0;
    const result = await hostShellTool.execute(
      { command: "echo should-not-run", target_client_id: "client-mac-abc123" },
      { ...makeContext(), transportInterface: "web" },
    );

    // Must error, NOT fall through to local spawn
    expect(result.isError).toBe(true);
    expect(result.content).toContain("client-mac-abc123");
    expect(result.content).toContain("no longer connected");
    expect(spawnCalls.length).toBe(0);
  });

  test("falls back to local execution when no proxy is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-shell-no-proxy-"));
    testDirs.push(dir);

    spawnCalls.length = 0;
    const result = await hostShellTool.execute(
      { command: "echo no-proxy", working_dir: dir },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("no-proxy");
    expect(spawnCalls.length).toBe(1);
  });

  test("propagates VELLUM_UNTRUSTED_SHELL env to proxy under CES lockdown", async () => {
    // Enable CES shell lockdown via the override cache
    const { _setOverridesForTesting } =
      await import("../config/assistant-feature-flags.js");
    _setOverridesForTesting({
      "ces-shell-lockdown": true,
    });

    const envSnapshot = captureEnv(ROUTING_ENV_KEYS);
    // Keep this test focused on lockdown propagation behavior only.
    for (const key of ROUTING_ENV_KEYS) {
      delete process.env[key];
    }

    try {
      const proxyResult: ToolExecutionResult = {
        content: "proxied",
        isError: false,
      };
      const calls = setupMockProxy(proxyResult);

      const ctx: ToolContext = {
        ...makeContext(),
        trustClass: "trusted_contact", // untrusted actor
      };

      const result = await hostShellTool.execute(
        { command: "echo lockdown" },
        ctx,
      );

      expect(result).toBe(proxyResult);
      expect(calls.length).toBe(1);
      expect(calls[0].input.env).toEqual({
        VELLUM_UNTRUSTED_SHELL: "1",
        __CONVERSATION_ID: "test-conversation",
      });
    } finally {
      _setOverridesForTesting({});
      restoreEnv(envSnapshot);
    }
  });

  test("does not propagate env to proxy when CES lockdown is inactive", async () => {
    const envSnapshot = captureEnv(ROUTING_ENV_KEYS);
    for (const key of ROUTING_ENV_KEYS) {
      delete process.env[key];
    }

    try {
      const proxyResult: ToolExecutionResult = {
        content: "proxied",
        isError: false,
      };
      const calls = setupMockProxy(proxyResult);

      const ctx: ToolContext = {
        ...makeContext(),
        trustClass: "guardian", // trusted actor — no lockdown
      };

      const result = await hostShellTool.execute(
        { command: "echo no-lockdown" },
        ctx,
      );

      expect(result).toBe(proxyResult);
      expect(calls.length).toBe(1);
      expect(calls[0].input.env).toEqual({
        __CONVERSATION_ID: "test-conversation",
      });
    } finally {
      restoreEnv(envSnapshot);
    }
  });

  test("propagates daemon routing env vars to proxy for nested assistant CLI calls", async () => {
    const envSnapshot = captureEnv([
      ...ROUTING_ENV_KEYS,
      "VELLUM_UNTRUSTED_SHELL",
    ]);
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/vellum-instance/.vellum/workspace";
    process.env.VELLUM_DATA_DIR = "/tmp/vellum-instance/.vellum/workspace/data";
    process.env.VELLUM_ENVIRONMENT = "local";
    process.env.INTERNAL_GATEWAY_BASE_URL = "http://127.0.0.1:7830";
    delete process.env.VELLUM_UNTRUSTED_SHELL;

    try {
      const proxyResult: ToolExecutionResult = {
        content: "proxied",
        isError: false,
      };
      const calls = setupMockProxy(proxyResult);

      const ctx: ToolContext = {
        ...makeContext(),
        trustClass: "guardian", // trusted actor — no lockdown
      };

      const result = await hostShellTool.execute(
        { command: "assistant browser status --json" },
        ctx,
      );

      expect(result).toBe(proxyResult);
      expect(calls.length).toBe(1);
      expect(calls[0].input.env).toEqual({
        VELLUM_WORKSPACE_DIR: "/tmp/vellum-instance/.vellum/workspace",
        VELLUM_DATA_DIR: "/tmp/vellum-instance/.vellum/workspace/data",
        VELLUM_ENVIRONMENT: "local",
        INTERNAL_GATEWAY_BASE_URL: "http://127.0.0.1:7830",
        __CONVERSATION_ID: "test-conversation",
      });
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});
