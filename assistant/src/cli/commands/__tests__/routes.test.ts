/**
 * Tests for the `assistant routes` CLI command (thin IPC wrapper).
 *
 * Validates:
 *   - `routes list` calls cliIpcCall("public_routes_list")
 *   - `routes list --json` outputs valid JSON containing route data
 *   - Empty routes list shows "No route handlers found"
 *   - `routes inspect <path>` calls cliIpcCall("public_routes_inspect", { queryParams: { path } })
 *   - 404 statusCode from IPC → exit 1 + "No handler file found" message
 *   - Generic IPC error → exit non-zero
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { routes: [], publicBase: null } };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
    throw new Error("exitFromIpcResult called");
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerRoutesCommand } = await import("../routes.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log.bind(console);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  console.log = (...logArgs: unknown[]) => {
    stdoutChunks.push(
      logArgs.map((a) => (typeof a === "string" ? a : String(a))).join(" ") +
        "\n",
    );
  };

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerRoutesCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { routes: [], publicBase: null } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// routes list
// ---------------------------------------------------------------------------

describe("assistant routes list", () => {
  test("calls cliIpcCall with public_routes_list", async () => {
    await runCommand(["routes", "list"]);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("public_routes_list");
  });

  test("empty routes shows guidance message", async () => {
    mockIpcResult = {
      ok: true,
      result: { routes: [], publicBase: null },
    };
    const { exitCode } = await runCommand(["routes", "list"]);
    expect(exitCode).toBe(0);
  });

  test("list --json: outputs valid JSON with routes array", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routes: [
          {
            routePath: "/x/my-app",
            methods: ["GET"],
            description: null,
            filePath: "my-app.ts",
            publicUrl: null,
          },
        ],
        publicBase: null,
      },
    };
    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/my-app");
  });

  test("list --json: stdout contains the route path", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routes: [
          {
            routePath: "/x/my-app",
            methods: ["GET"],
            description: null,
            filePath: "my-app.ts",
            publicUrl: null,
          },
        ],
        publicBase: null,
      },
    };
    const { stdout } = await runCommand(["routes", "list", "--json"]);
    expect(stdout).toContain("/x/my-app");
  });

  test("list --json: empty routes returns empty array", async () => {
    mockIpcResult = {
      ok: true,
      result: { routes: [], publicBase: null },
    };
    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("list --json: includes publicUrl when publicBase is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routes: [
          {
            routePath: "/x/status",
            methods: ["GET"],
            description: null,
            filePath: "status.ts",
            publicUrl: "https://example.com/v1/assistants/asst_xyz/x/status",
          },
        ],
        publicBase: "https://example.com/v1/assistants/asst_xyz",
      },
    };
    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].publicUrl).toBe(
      "https://example.com/v1/assistants/asst_xyz/x/status",
    );
  });

  test("list: IPC error exits non-zero", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant",
    };
    const { exitCode } = await runCommand(["routes", "list"]);
    expect(exitCode).not.toBe(0);
  });

  test("list --json: IPC error outputs structured error JSON", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant",
    };
    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });

  test("list: human output runs without error for populated routes", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routes: [
          {
            routePath: "/x/status",
            methods: ["GET", "POST"],
            description: "Health check",
            filePath: "status.ts",
            publicUrl: null,
          },
        ],
        publicBase: null,
      },
    };
    const { exitCode } = await runCommand(["routes", "list"]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// routes inspect
// ---------------------------------------------------------------------------

describe("assistant routes inspect", () => {
  test("calls cliIpcCall with public_routes_inspect and path queryParam", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routePath: "/x/my-app/submit",
        methods: ["POST"],
        description: null,
        filePath: "/workspace/routes/my-app/submit.ts",
        publicUrl: null,
        fileSize: 128,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    await runCommand(["routes", "inspect", "my-app/submit"]);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("public_routes_inspect");
    expect(lastIpcCall!.params).toEqual({
      queryParams: { path: "my-app/submit" },
    });
  });

  test("inspect --json: outputs structured route info", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routePath: "/x/status",
        methods: ["GET"],
        description: "Health check",
        filePath: "/workspace/routes/status.ts",
        publicUrl: null,
        fileSize: 256,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "status",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.route.routePath).toBe("/x/status");
    expect(parsed.route.methods).toEqual(["GET"]);
    expect(parsed.route.description).toBe("Health check");
    expect(parsed.route.fileSize).toBe(256);
    expect(parsed.route.modifiedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("inspect: 404 statusCode exits 1 with 'No handler file found'", async () => {
    mockIpcResult = {
      ok: false,
      error: 'No handler file found for route path "nonexistent"',
      statusCode: 404,
    };
    const { exitCode, stdout, stderr } = await runCommand([
      "routes",
      "inspect",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toContain("No handler file found");
  });

  test("inspect: 404 human output exits 1", async () => {
    mockIpcResult = {
      ok: false,
      error: 'No handler file found for route path "missing"',
      statusCode: 404,
    };
    const { exitCode } = await runCommand(["routes", "inspect", "missing"]);
    expect(exitCode).toBe(1);
  });

  test("inspect: generic IPC error exits non-zero", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant",
    };
    const { exitCode } = await runCommand(["routes", "inspect", "status"]);
    expect(exitCode).not.toBe(0);
  });

  test("inspect --json: generic IPC error outputs structured error", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant",
    };
    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "status",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });

  test("inspect: human output runs without error on success", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routePath: "/x/check",
        methods: ["GET"],
        description: null,
        filePath: "/workspace/routes/check.ts",
        publicUrl: null,
        fileSize: 64,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { exitCode } = await runCommand(["routes", "inspect", "check"]);
    expect(exitCode).toBe(0);
  });

  test("inspect --json: includes publicUrl when set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        routePath: "/x/submit",
        methods: ["POST"],
        description: null,
        filePath: "/workspace/routes/submit.ts",
        publicUrl: "https://example.com/v1/assistants/asst_1/x/submit",
        fileSize: 128,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "submit",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.route.publicUrl).toBe(
      "https://example.com/v1/assistants/asst_1/x/submit",
    );
  });
});
