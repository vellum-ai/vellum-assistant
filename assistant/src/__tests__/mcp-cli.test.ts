import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

const CLI = join(import.meta.dir, "..", "index.ts");

let testDataDir: string;
let configPath: string;

function runMcp(
  subcommand: string,
  args: string[] = [],
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", ["run", CLI, "mcp", subcommand, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, BASE_DATA_DIR: testDataDir },
  });
  return {
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    exitCode: result.status ?? 1,
  };
}

function runMcpList(args: string[] = []) {
  return runMcp("list", args);
}

function runMcpAdd(name: string, args: string[]) {
  return runMcp("add", [name, ...args]);
}

function runMcpRemove(name: string) {
  return runMcp("remove", [name]);
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

describe("vellum mcp list", () => {
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

  test("shows message when no MCP servers configured", () => {
    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No MCP servers configured");
  });

  test("lists configured servers", () => {
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

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 MCP server(s) configured");
    expect(stdout).toContain("test-server");
    expect(stdout).toContain("streamable-http");
    expect(stdout).toContain("https://example.com/mcp");
    expect(stdout).toContain("medium");
  });

  test("shows disabled status", () => {
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

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
  });

  test("shows stdio command info", () => {
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

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stdio-server");
    expect(stdout).toContain("stdio");
    expect(stdout).toContain("npx -y some-mcp-server");
    expect(stdout).toContain("low");
  });

  test("--json outputs valid JSON", () => {
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

    const { stdout, exitCode } = runMcpList(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("json-server");
    expect(parsed[0].transport.url).toBe("https://example.com/mcp");
  });

  test("--json outputs empty array when no servers", () => {
    const { stdout, exitCode } = runMcpList(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual([]);
  });
});

describe("vellum mcp add", () => {
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

  test("adds a streamable-http server", () => {
    const { stdout, exitCode } = runMcpAdd("test-http", [
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

  test("adds a stdio server with args", () => {
    const { stdout, exitCode } = runMcpAdd("test-stdio", [
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

  test("adds server as disabled with --disabled flag", () => {
    const { exitCode } = runMcpAdd("test-disabled", [
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

  test("rejects duplicate server name", () => {
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

    const { stderr } = runMcpAdd("existing", [
      "-t",
      "sse",
      "-u",
      "https://other.com",
    ]);
    expect(stderr).toContain("already exists");
  });

  test("rejects stdio without --command", () => {
    const { stderr } = runMcpAdd("bad-stdio", ["-t", "stdio"]);
    expect(stderr).toContain("--command is required");
  });

  test("rejects streamable-http without --url", () => {
    const { stderr } = runMcpAdd("bad-http", ["-t", "streamable-http"]);
    expect(stderr).toContain("--url is required");
  });

  test("defaults risk to high", () => {
    const { exitCode } = runMcpAdd("default-risk", [
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

describe("vellum mcp remove", () => {
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

  test("removes an existing server", () => {
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

    const { stdout, exitCode } = runMcpRemove("my-server");
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Removed MCP server "my-server"');

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    expect(servers?.["my-server"]).toBeUndefined();
  });

  test("errors when server does not exist", () => {
    const { stderr, exitCode } = runMcpRemove("nonexistent");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("preserves other servers when removing one", () => {
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

    const { exitCode } = runMcpRemove("remove-me");
    expect(exitCode).toBe(0);

    const updated = readConfig();
    const servers = (updated.mcp as Record<string, unknown> | undefined)
      ?.servers as Record<string, unknown> | undefined;
    expect(servers?.["remove-me"]).toBeUndefined();
    expect(servers?.["keep-me"]).toBeDefined();
  });
});
