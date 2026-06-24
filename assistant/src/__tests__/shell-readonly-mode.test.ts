import { describe, expect, mock, test } from "bun:test";

// Mock logger
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock registry
mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// Mock config
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600 },
    secretDetection: { allowOneTimeSend: false },
  }),
}));

// Mock secret scanner
mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

// Mock safe-env
mock.module("../tools/terminal/safe-env.js", () => ({
  buildSanitizedEnv: () => ({ PATH: "/usr/bin" }),
}));

// Mock proxy session manager
mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: mock(() =>
    Promise.resolve({ session: { id: "test-session" } }),
  ),
  getSessionEnv: mock(() => ({ HTTPS_PROXY: "http://test" })),
}));

// Import the shell tool after mocks
import { shellTool } from "../tools/terminal/shell.js";
import type { ToolContext } from "../tools/types.js";

const baseCtx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv-readonly",
  trustClass: "guardian",
};

describe("shell tool read-only mode enforcement", () => {
  test("allows grep in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "grep -rn 'foo' /tmp", activity: "test" },
      ctx,
    );
    // Command should execute (not rejected). It may error if grep finds
    // nothing, but the error should be from grep, not from the gate.
    expect(result.isError).toBe(false);
  });

  test("blocks rm in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "rm /tmp/test-file", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only shell policy");
  });

  test("blocks command chaining in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "grep foo /tmp/file; rm /tmp/file", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only shell policy");
  });

  test("blocks output redirection in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "echo hello > /tmp/out.txt", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only shell policy");
  });

  test("blocks sed -i in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "sed -i 's/foo/bar/' /tmp/file", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only shell policy");
  });

  test("allows cat in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "cat /etc/hostname", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  test("allows git log in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "git log --oneline -1", activity: "test" },
      ctx,
    );
    // git log may fail if not in a git repo, but it shouldn't be blocked
    // by the read-only gate
    if (result.isError) {
      expect(result.content).not.toContain("read-only shell policy");
    }
  });

  test("blocks git commit in read-only mode", async () => {
    const ctx = { ...baseCtx, shellMode: "read-only" as const };
    const result = await shellTool.execute(
      { command: "git commit -m 'test'", activity: "test" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only shell policy");
  });

  test("no enforcement when shellMode is undefined (unrestricted)", async () => {
    const ctx = { ...baseCtx };
    const result = await shellTool.execute(
      { command: "rm /tmp/nonexistent-readonly-test", activity: "test" },
      ctx,
    );
    // rm should execute (and fail because file doesn't exist), but NOT
    // be blocked by the read-only gate
    if (result.isError) {
      expect(result.content).not.toContain("read-only shell policy");
    }
  });

  test("no enforcement when shellMode is unrestricted", async () => {
    const ctx = { ...baseCtx, shellMode: "unrestricted" as const };
    const result = await shellTool.execute(
      { command: "rm /tmp/nonexistent-readonly-test", activity: "test" },
      ctx,
    );
    if (result.isError) {
      expect(result.content).not.toContain("read-only shell policy");
    }
  });
});
