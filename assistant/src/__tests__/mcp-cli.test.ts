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
    warn: () => {},
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
  McpOAuthProvider: class {},
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
  process.env.BASE_DATA_DIR = testDataDir;

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
    const workspaceDir = join(testDataDir, ".vellum", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    configPath = join(workspaceDir, "config.json");
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
    const workspaceDir = join(testDataDir, ".vellum", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    configPath = join(workspaceDir, "config.json");
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
});

describe("assistant mcp remove", () => {
  beforeAll(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-mcp-remove-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    const workspaceDir = join(testDataDir, ".vellum", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    configPath = join(workspaceDir, "config.json");
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
