import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { getWorkspaceRoutesDir } from "../../../util/platform.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockPublicBaseUrl: string | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    ingress: mockPublicBaseUrl
      ? { publicBaseUrl: mockPublicBaseUrl }
      : undefined,
  }),
}));

mock.module("../../../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config.ingress?.publicBaseUrl;
    if (!url) throw new Error("No public base URL configured");
    return url;
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
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log.bind(console);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

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

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Helpers for writing handler files into the workspace routes dir
// ---------------------------------------------------------------------------

let routesDir: string;

function writeHandler(relativePath: string, content: string): void {
  const fullPath = join(routesDir, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  routesDir = getWorkspaceRoutesDir();
  mkdirSync(routesDir, { recursive: true });
  mockPublicBaseUrl = null;
  process.exitCode = 0;
});

afterEach(() => {
  try {
    rmSync(routesDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// routes list
// ---------------------------------------------------------------------------

describe("assistant routes list", () => {
  test("empty routes dir returns zero routes in JSON", async () => {
    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("empty routes dir shows guidance in human output", async () => {
    const { exitCode } = await runCommand(["routes", "list"]);
    expect(exitCode).toBe(0);
  });

  test("discovers a single GET handler", async () => {
    writeHandler(
      "status.ts",
      `export async function GET(req: Request) { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/status");
    expect(parsed.routes[0].methods).toEqual(["GET"]);
  });

  test("discovers multiple routes sorted alphabetically", async () => {
    writeHandler(
      "zebra.ts",
      `export function GET() { return new Response("z"); }`,
    );
    writeHandler(
      "alpha.ts",
      `export function POST() { return new Response("a"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0].routePath).toBe("/x/alpha");
    expect(parsed.routes[1].routePath).toBe("/x/zebra");
  });

  test("discovers multi-method handler", async () => {
    writeHandler(
      "items.ts",
      [
        `export function GET() { return new Response("list"); }`,
        `export function POST() { return new Response("create"); }`,
        `export function DELETE() { return new Response("remove"); }`,
      ].join("\n"),
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("discovers index file as directory route", async () => {
    writeHandler(
      "my-app/index.ts",
      `export function GET() { return new Response("app"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/my-app");
  });

  test("discovers subdirectory routes", async () => {
    writeHandler(
      "api/v1/users.ts",
      `export function GET() { return new Response("users"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].routePath).toBe("/x/api/v1/users");
  });

  test("discovers .js handlers", async () => {
    writeHandler(
      "health.js",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/health");
  });

  test("extracts description export", async () => {
    writeHandler(
      "submit.ts",
      [
        `export const description = "Form submission handler";`,
        `export function POST() { return new Response("ok"); }`,
      ].join("\n"),
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].description).toBe("Form submission handler");
  });

  test("null description when not exported", async () => {
    writeHandler(
      "simple.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].description).toBeNull();
  });

  test("includes publicUrl when public base URL is configured", async () => {
    mockPublicBaseUrl = "https://example.ngrok-free.app/v1/assistants/asst_xyz";
    writeHandler(
      "status.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].publicUrl).toBe(
      "https://example.ngrok-free.app/v1/assistants/asst_xyz/x/status",
    );
  });

  test("publicUrl is null when no public base URL configured", async () => {
    mockPublicBaseUrl = null;
    writeHandler(
      "status.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].publicUrl).toBeNull();
  });

  test("ignores non-handler files", async () => {
    writeHandler("readme.md", "# Routes\nDocumentation file");
    writeHandler(
      "handler.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/handler");
  });

  test("human output runs without error for populated routes", async () => {
    writeHandler(
      "status.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode } = await runCommand(["routes", "list"]);
    expect(exitCode).toBe(0);
  });

  test("root index file maps to /x/", async () => {
    writeHandler(
      "index.ts",
      `export function GET() { return new Response("root"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].routePath).toBe("/x/");
  });

  test("JSON output includes filePath relative to routes dir", async () => {
    writeHandler(
      "api/submit.ts",
      `export function POST() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand(["routes", "list", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.routes[0].filePath).toBe("api/submit.ts");
  });
});

// ---------------------------------------------------------------------------
// routes inspect
// ---------------------------------------------------------------------------

describe("assistant routes inspect", () => {
  test("inspects a handler by route path (JSON)", async () => {
    writeHandler(
      "status.ts",
      [
        `export const description = "Health check endpoint";`,
        `export function GET() { return new Response("ok"); }`,
        `export function POST() { return new Response("created"); }`,
      ].join("\n"),
    );

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
    expect(parsed.route.methods).toEqual(["GET", "POST"]);
    expect(parsed.route.description).toBe("Health check endpoint");
    expect(parsed.route.filePath).toContain("status.ts");
    expect(parsed.route.fileSize).toBeGreaterThan(0);
    expect(parsed.route.modifiedAt).toBeTruthy();
  });

  test("inspect resolves index file convention", async () => {
    writeHandler(
      "dashboard/index.ts",
      `export function GET() { return new Response("dashboard"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "dashboard",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.route.routePath).toBe("/x/dashboard");
    expect(parsed.route.methods).toEqual(["GET"]);
    expect(parsed.route.filePath).toContain("index.ts");
  });

  test("inspect resolves .js files", async () => {
    writeHandler(
      "legacy.js",
      `export function POST() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "legacy",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.route.filePath).toContain("legacy.js");
  });

  test("inspect includes publicUrl when configured", async () => {
    mockPublicBaseUrl = "https://example.com/v1/assistants/asst_1";
    writeHandler(
      "submit.ts",
      `export function POST() { return new Response("ok"); }`,
    );

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

  test("inspect publicUrl is null when not configured", async () => {
    mockPublicBaseUrl = null;
    writeHandler(
      "submit.ts",
      `export function POST() { return new Response("ok"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "submit",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.route.publicUrl).toBeNull();
  });

  test("inspect returns error for missing handler (JSON)", async () => {
    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "nonexistent",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No handler file found");
    expect(parsed.error).toContain("nonexistent");
  });

  test("inspect returns error for missing handler (human output)", async () => {
    const { exitCode } = await runCommand(["routes", "inspect", "nonexistent"]);
    expect(exitCode).toBe(1);
  });

  test("inspect handles subdirectory routes", async () => {
    writeHandler(
      "api/v2/users.ts",
      `export function GET() { return new Response("users"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "api/v2/users",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.route.routePath).toBe("/x/api/v2/users");
  });

  test("inspect human output runs without error", async () => {
    writeHandler(
      "check.ts",
      `export function GET() { return new Response("ok"); }`,
    );

    const { exitCode } = await runCommand(["routes", "inspect", "check"]);
    expect(exitCode).toBe(0);
  });

  test("inspect shows handler with no exported methods", async () => {
    writeHandler("empty.ts", `export const description = "Placeholder";`);

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "empty",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.route.methods).toEqual([]);
    expect(parsed.route.description).toBe("Placeholder");
  });

  test("inspect prefers direct file over index file", async () => {
    writeHandler(
      "ambiguous.ts",
      `export function GET() { return new Response("direct"); }`,
    );
    writeHandler(
      "ambiguous/index.ts",
      `export function POST() { return new Response("index"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "ambiguous",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    // Direct file should be preferred over index
    expect(parsed.route.methods).toEqual(["GET"]);
  });

  test("inspect prefers .ts over .js", async () => {
    writeHandler(
      "both.ts",
      `export function GET() { return new Response("ts"); }`,
    );
    writeHandler(
      "both.js",
      `export function POST() { return new Response("js"); }`,
    );

    const { exitCode, stdout } = await runCommand([
      "routes",
      "inspect",
      "both",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    // .ts is checked first in HANDLER_EXTENSIONS
    expect(parsed.route.methods).toEqual(["GET"]);
  });
});
