import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { Command } from "commander";

// ── Module mocks (must precede imports that pull them in) ──────────────

type MockIpcResult = { ok: boolean; result?: unknown; error?: string };
let mockCliIpcCallFn: ReturnType<
  typeof mock<
    (
      method: string,
      params?: Record<string, unknown>,
      opts?: { timeoutMs?: number },
    ) => Promise<MockIpcResult>
  >
> = mock(
  (
    _method: string,
    _params?: Record<string, unknown>,
    _opts?: { timeoutMs?: number },
  ): Promise<MockIpcResult> =>
    Promise.resolve({
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    }),
);

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: (
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => mockCliIpcCallFn(method, params, opts),
}));

let mockOpenInHostBrowserFn = mock(async (_url: string) => {});

mock.module("../util/browser.js", () => ({
  openInHostBrowser: (url: string) => mockOpenInHostBrowserFn(url),
}));

let stdoutLines: string[] = [];
let stderrLines: string[] = [];

mock.module("../util/logger.js", () => ({
  getCliLogger: () => ({
    info: (...args: unknown[]) => {
      stdoutLines.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    },
    warn: (...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    },
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  }),
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../mcp/mcp-oauth-provider.js", () => ({
  deleteMcpOAuthCredentials: async () => {},
}));

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    async connect() {
      throw new Error("Connection refused");
    }
    async disconnect() {}
    get isConnected() {
      return false;
    }
  },
}));

const { registerMcpCommand } = await import("../cli/commands/mcp.js");

// ── Helpers ───────────────────────────────────────────────────────────

let testDataDir: string;
let configPath: string;

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

async function runMcp(
  subcommand: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  stdoutLines = [];
  stderrLines = [];
  process.exitCode = 0;

  const stdoutWrites: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origExit = process.exit;

  // Capture process.stdout.write (used by --json output)
  process.stdout.write = ((data: unknown) => {
    stdoutWrites.push(typeof data === "string" ? data : String(data));
    return true;
  }) as typeof process.stdout.write;

  // Override process.exit to not kill the process
  process.exit = ((code?: number) => {
    if (code !== undefined) process.exitCode = code;
  }) as typeof process.exit;

  // Point config loader at the test data dir
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;

  try {
    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);
    await program.parseAsync(["node", "vellum", "mcp", subcommand, ...args]);
  } catch (e: unknown) {
    // Commander exitOverride throws on parse errors
    if (e && typeof e === "object" && "exitCode" in e) {
      process.exitCode = (e as { exitCode: number }).exitCode;
    } else {
      throw e;
    }
  } finally {
    process.stdout.write = origWrite;
    process.exit = origExit;
  }

  const stdout = [...stdoutLines, ...stdoutWrites].join("\n");
  const stderr = stderrLines.join("\n");
  return { stdout, stderr, exitCode: (process.exitCode as number) ?? 0 };
}

async function runMcpList(args: string[] = []) {
  return runMcp("list", args);
}

async function runMcpAdd(name: string, args: string[]) {
  return runMcp("add", [name, ...args]);
}

async function runMcpRemove(name: string) {
  return runMcp("remove", [name]);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("assistant mcp list", () => {
  beforeAll(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDataDir, { recursive: true });
    configPath = join(testDataDir, "config.json");
    writeConfig({});
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeConfig({});
  });

  test("shows message when no MCP servers configured", async () => {
    const { stdout, exitCode } = await runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No MCP servers configured");
  });

  test("lists configured servers", async () => {
    writeConfig({
      mcp: {
        servers: {
          "test-server": {
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
            enabled: true,
            defaultRiskLevel: "medium",
          },
        },
      },
    });

    const { stdout, exitCode } = await runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 MCP server(s) configured");
    expect(stdout).toContain("test-server");
    expect(stdout).toContain("streamable-http");
    expect(stdout).toContain("https://example.com/mcp");
    expect(stdout).toContain("medium");
  });

  test("shows disabled status", async () => {
    writeConfig({
      mcp: {
        servers: {
          "disabled-server": {
            transport: { type: "sse", url: "https://example.com/sse" },
            enabled: false,
            defaultRiskLevel: "high",
          },
        },
      },
    });

    const { stdout, exitCode } = await runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
  });

  test("shows stdio command info", async () => {
    writeConfig({
      mcp: {
        servers: {
          "stdio-server": {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "some-mcp-server"],
            },
            enabled: true,
            defaultRiskLevel: "low",
          },
        },
      },
    });

    const { stdout, exitCode } = await runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stdio-server");
    expect(stdout).toContain("stdio");
    expect(stdout).toContain("npx -y some-mcp-server");
    expect(stdout).toContain("low");
  });

  test("--json outputs valid JSON", async () => {
    writeConfig({
      mcp: {
        servers: {
          "json-server": {
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
            enabled: true,
            defaultRiskLevel: "high",
          },
        },
      },
    });

    const { stdout, exitCode } = await runMcpList(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("json-server");
    expect(parsed[0].transport.url).toBe("https://example.com/mcp");
  });

  test("--json outputs empty array when no servers", async () => {
    const { stdout, exitCode } = await runMcpList(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual([]);
  });
});

describe("assistant mcp add", () => {
  beforeAll(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-mcp-add-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDataDir, { recursive: true });
    configPath = join(testDataDir, "config.json");
    writeConfig({});
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeConfig({});
  });

  test("adds a streamable-http server", async () => {
    const { stdout, exitCode } = await runMcpAdd("test-http", [
      "-t",
      "streamable-http",
      "-u",
      "https://example.com/mcp",
      "-r",
      "medium",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Added MCP server "test-http"');

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    const server = servers?.["test-http"] as Record<string, unknown>;
    expect(server).toBeDefined();
    expect((server.transport as Record<string, unknown>).type).toBe(
      "streamable-http",
    );
    expect((server.transport as Record<string, unknown>).url).toBe(
      "https://example.com/mcp",
    );
    expect(server.defaultRiskLevel).toBe("medium");
    expect(server.enabled).toBe(true);
  });

  test("adds a stdio server with args", async () => {
    const { stdout, exitCode } = await runMcpAdd("test-stdio", [
      "-t",
      "stdio",
      "-c",
      "npx",
      "-a",
      "-y",
      "some-server",
      "-r",
      "low",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Added MCP server "test-stdio"');

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    const server = servers?.["test-stdio"] as Record<string, unknown>;
    const transport = server.transport as Record<string, unknown>;
    expect(transport.type).toBe("stdio");
    expect(transport.command).toBe("npx");
    expect(transport.args).toEqual(["-y", "some-server"]);
  });

  test("adds server as disabled with --disabled flag", async () => {
    const { exitCode } = await runMcpAdd("test-disabled", [
      "-t",
      "sse",
      "-u",
      "https://example.com/sse",
      "--disabled",
    ]);
    expect(exitCode).toBe(0);

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    const server = servers?.["test-disabled"] as Record<string, unknown>;
    expect(server.enabled).toBe(false);
  });

  test("rejects duplicate server name", async () => {
    writeConfig({
      mcp: {
        servers: {
          existing: {
            transport: { type: "sse", url: "https://example.com" },
            enabled: true,
            defaultRiskLevel: "high",
          },
        },
      },
    });

    const { stderr } = await runMcpAdd("existing", [
      "-t",
      "sse",
      "-u",
      "https://other.com",
    ]);
    expect(stderr).toContain("already exists");
  });

  test("rejects stdio without --command", async () => {
    const { stderr } = await runMcpAdd("bad-stdio", ["-t", "stdio"]);
    expect(stderr).toContain("--command is required");
  });

  test("rejects streamable-http without --url", async () => {
    const { stderr } = await runMcpAdd("bad-http", ["-t", "streamable-http"]);
    expect(stderr).toContain("--url is required");
  });

  test("defaults risk to high", async () => {
    const { exitCode } = await runMcpAdd("default-risk", [
      "-t",
      "sse",
      "-u",
      "https://example.com/sse",
    ]);
    expect(exitCode).toBe(0);

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    const server = servers?.["default-risk"] as Record<string, unknown>;
    expect(server.defaultRiskLevel).toBe("high");
  });

  test("calls cliIpcCall with internal_mcp_reload after saving server", async () => {
    mockCliIpcCallFn = mock(() => Promise.resolve({ ok: true }));

    await runMcpAdd("reload-test-server", [
      "-t",
      "sse",
      "-u",
      "https://example.com/sse",
    ]);

    const reloadCall = mockCliIpcCallFn.mock.calls.find(
      (c) => c[0] === "internal_mcp_reload",
    );
    expect(reloadCall).toBeDefined();
    expect(reloadCall![1]).toEqual({ body: {} });
  });
});

describe("assistant mcp remove", () => {
  beforeAll(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-mcp-remove-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(testDataDir, { recursive: true });
    configPath = join(testDataDir, "config.json");
    writeConfig({});
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeConfig({});
  });

  test("removes an existing server", async () => {
    writeConfig({
      mcp: {
        servers: {
          "my-server": {
            transport: { type: "sse", url: "https://example.com/sse" },
            enabled: true,
            defaultRiskLevel: "high",
          },
        },
      },
    });

    const { stdout, exitCode } = await runMcpRemove("my-server");
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Removed MCP server "my-server"');

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    expect(servers?.["my-server"]).toBeUndefined();
  });

  test("errors when server does not exist", async () => {
    const { stderr, exitCode } = await runMcpRemove("nonexistent");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("preserves other servers when removing one", async () => {
    writeConfig({
      mcp: {
        servers: {
          "keep-me": {
            transport: {
              type: "streamable-http",
              url: "https://example.com/keep",
            },
            enabled: true,
            defaultRiskLevel: "low",
          },
          "remove-me": {
            transport: { type: "sse", url: "https://example.com/remove" },
            enabled: true,
            defaultRiskLevel: "high",
          },
        },
      },
    });

    const { exitCode } = await runMcpRemove("remove-me");
    expect(exitCode).toBe(0);

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    expect(servers?.["remove-me"]).toBeUndefined();
    expect(servers?.["keep-me"]).toBeDefined();
  });
});

describe("assistant mcp reload", () => {
  beforeAll(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-mcp-reload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDataDir, { recursive: true });
    configPath = join(testDataDir, "config.json");
    writeConfig({});
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockCliIpcCallFn = mock(() => Promise.resolve({ ok: true }));
  });

  test("calls cliIpcCall with internal_mcp_reload", async () => {
    const { stdout } = await runMcp("reload");

    const reloadCall = mockCliIpcCallFn.mock.calls.find(
      (c) => c[0] === "internal_mcp_reload",
    );
    expect(reloadCall).toBeDefined();
    expect(reloadCall![1]).toEqual({ body: {} });
    expect(stdout).toContain("MCP reload signal sent");
  });

  test("warns but does not fail when daemon is unreachable", async () => {
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Could not connect to assistant daemon",
      }),
    );

    const { exitCode, stderr } = await runMcp("reload");

    expect(exitCode).toBe(0); // best-effort, not fatal
    expect(stderr).toContain("Could not signal reload");
  });
});

describe("assistant mcp auth — IPC path", () => {
  let ipcTestDataDir: string;
  let ipcConfigPath: string;

  beforeAll(() => {
    ipcTestDataDir = join(
      tmpdir(),
      `vellum-mcp-auth-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(ipcTestDataDir, { recursive: true });
    ipcConfigPath = join(ipcTestDataDir, "config.json");
    writeFileSync(
      ipcConfigPath,
      JSON.stringify({
        mcp: {
          servers: {
            srv: {
              transport: { type: "sse", url: "https://mcp.example.com/sse" },
              enabled: true,
              defaultRiskLevel: "high",
            },
          },
        },
      }),
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(ipcTestDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // runMcp() sets VELLUM_WORKSPACE_DIR = testDataDir; align the module-level
    // variable with the IPC-specific directory so the config loader sees the
    // SSE server config created in beforeAll.
    testDataDir = ipcTestDataDir;
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Could not connect to assistant daemon. Is it running?",
      }),
    );
    mockOpenInHostBrowserFn = mock(async (_url: string) => {});
    stdoutLines = [];
    stderrLines = [];
    process.exitCode = 0;
  });

  test("mcp auth calls IPC internal_mcp_auth_start first", async () => {
    let ipcCallIndex = 0;
    mockCliIpcCallFn = mock(() => {
      ipcCallIndex++;
      if (ipcCallIndex === 1) {
        // start call
        return Promise.resolve({
          ok: true,
          result: { auth_url: "https://auth.example.com", state: "srv" },
        });
      }
      // poll calls → complete
      return Promise.resolve({
        ok: true,
        result: { status: "complete" },
      });
    });

    await runMcp("auth", ["srv"]);

    expect(mockCliIpcCallFn.mock.calls[0][0]).toBe("internal_mcp_auth_start");
    expect(mockCliIpcCallFn.mock.calls[0][1]).toEqual({
      body: { serverId: "srv" },
    });
    expect(mockOpenInHostBrowserFn).toHaveBeenCalledWith(
      "https://auth.example.com",
    );
  });

  test("IPC start returns ok=false (daemon unavailable) → exits 1 with helpful error", async () => {
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Could not connect to assistant daemon. Is it running?",
      }),
    );

    const { exitCode, stderr } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Is it running?");
  });

  test("IPC start returns ok=false (Unknown method) → exits 1 with helpful error", async () => {
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Unknown method: internal_mcp_auth_start",
      }),
    );

    const { exitCode, stderr } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Is it running?");
  });

  test("IPC start returns ok=false with a real daemon error → exits 1 without falling back to loopback", async () => {
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "MCP server not configured for OAuth",
      }),
    );

    await runMcp("auth", ["srv"]);

    // Should have surfaced the daemon error and set exit code 1, not fallen
    // back to loopback (which would have constructed the OAuth provider and
    // possibly opened a browser via the loopback path).
    expect(process.exitCode).toBe(1);
    expect(mockOpenInHostBrowserFn).not.toHaveBeenCalled();
    // Exactly one IPC call (the start) — no polling, no retry.
    expect(mockCliIpcCallFn.mock.calls.length).toBe(1);
    expect(mockCliIpcCallFn.mock.calls[0][0]).toBe("internal_mcp_auth_start");
  });

  test("polling complete → exits 0 (daemon-side reload triggers itself; CLI no longer writes file signal)", async () => {
    let ipcCallIndex = 0;
    mockCliIpcCallFn = mock(() => {
      ipcCallIndex++;
      if (ipcCallIndex === 1) {
        return Promise.resolve({
          ok: true,
          result: { auth_url: "https://auth.example.com", state: "srv" },
        });
      }
      return Promise.resolve({
        ok: true,
        result: { status: "complete" },
      });
    });

    const { exitCode, stdout } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Authentication successful");
    // The IPC success path relies on the daemon-side orchestrator to call
    // reloadMcpServers() itself on completion — no CLI-side signal needed.
  });

  test("polling error → exits 1 with error message", async () => {
    let ipcCallIndex = 0;
    mockCliIpcCallFn = mock(() => {
      ipcCallIndex++;
      if (ipcCallIndex === 1) {
        return Promise.resolve({
          ok: true,
          result: { auth_url: "https://auth.example.com", state: "srv" },
        });
      }
      return Promise.resolve({
        ok: true,
        result: { status: "error", error: "access_denied" },
      });
    });

    const { exitCode, stderr } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/cancelled|access_denied|OAuth failed/);
  });

  test("polling gets NotFoundError (daemon restarted) → exits 1 with helpful message immediately", async () => {
    let ipcCallIndex = 0;
    mockCliIpcCallFn = mock(() => {
      ipcCallIndex++;
      if (ipcCallIndex === 1) {
        return Promise.resolve({
          ok: true,
          result: { auth_url: "https://auth.example.com", state: "srv" },
        });
      }
      // Daemon restarted — state lost
      return Promise.resolve({
        ok: false,
        error: 'No active OAuth flow for server "srv"',
      });
    });

    const { exitCode, stderr } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/assistant may have restarted|OAuth flow was lost/);
  });

  test("IPC start returns ok=true with already_authenticated → exits 0 without OAuth flow", async () => {
    mockCliIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { auth_url: "", state: "srv", already_authenticated: true },
      }),
    );

    const { exitCode, stdout } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already authenticated");
    // Should not have opened the browser or started polling
    expect(mockOpenInHostBrowserFn).not.toHaveBeenCalled();
    expect(mockCliIpcCallFn.mock.calls.length).toBe(1);
  });

  test("polling gets a non-notfound IPC error → exits 1 immediately with the error message", async () => {
    let ipcCallIndex = 0;
    mockCliIpcCallFn = mock(() => {
      ipcCallIndex++;
      if (ipcCallIndex === 1) {
        return Promise.resolve({
          ok: true,
          result: { auth_url: "https://auth.example.com", state: "srv" },
        });
      }
      // Unexpected IPC error (not "No active OAuth flow")
      return Promise.resolve({
        ok: false,
        error: "Internal server error during polling",
      });
    });

    const { exitCode, stderr } = await runMcp("auth", ["srv"]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Internal server error during polling/);
    // Should fail fast — only 1 start call + 1 poll call, not the full timeout
    expect(mockCliIpcCallFn.mock.calls.length).toBe(2);
  });
});
