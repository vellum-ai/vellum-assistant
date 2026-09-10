/**
 * Tests for `assistant apps inspect` and `assistant apps refresh`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createApp, getAppDirPath } from "../../../apps/app-store.js";
import { writeAppSourceFingerprint } from "../../../apps/source-fingerprint.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { runCliCommand } from "./cli-test-harness.js";

let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { ok: true, compiled: true } };

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitCodeFromIpcResult: (r: { statusCode?: number }) => {
    if (r.statusCode === undefined) {
      return 10;
    }
    if (r.statusCode >= 500) {
      return 3;
    }
    if (r.statusCode >= 400) {
      return 2;
    }
    return 1;
  },
}));

const { registerAppsCommand } = await import("../apps.js");

let workspaceDir: string;
let previousWorkspaceDir: string | undefined;

function freshWorkspace(): string {
  return join(
    tmpdir(),
    `vellum-apps-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function uniqueAppName(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  workspaceDir = freshWorkspace();
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: {
      ok: true,
      appId: "app-1",
      name: "Budget",
      compiled: true,
      compile_duration_ms: 12,
    },
  };
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
});

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("assistant apps inspect", () => {
  test("reports never_compiled for a new workspace app", async () => {
    const name = uniqueAppName("Inspect Fresh");
    const created = createApp({
      name,
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "inspect",
      created.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(true);
    const compile = body.compile as { status: string };
    expect(compile.status).toBe("never_compiled");
  });

  test("reports stale after source changes since the last fingerprint", async () => {
    const name = uniqueAppName("Inspect Stale");
    const created = createApp({
      name,
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });
    const appDir = getAppDirPath(created.id);
    expect(appDir.length).toBeGreaterThan(0);
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeFileSync(join(appDir, "src", "main.tsx"), "export const n = 1;\n");
    mkdirSync(join(appDir, "dist"), { recursive: true });
    writeFileSync(join(appDir, "dist", "index.html"), "<html></html>");
    writeAppSourceFingerprint(appDir, join(appDir, "dist"));
    writeFileSync(join(appDir, "src", "main.tsx"), "export const n = 2;\n");

    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "inspect",
      created.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const body = parseJson(result.stdout);
    const app = body.app as { id: string; source: string };
    expect(app.id).toBe(created.id);
    expect(app.source).toBe(appDir);
    const compile = body.compile as {
      status: string;
      modified: string[];
    };
    expect(compile.status).toBe("stale");
    expect(compile.modified).toEqual(["src/main.tsx"]);
  });

  test("exits 1 for an unknown app", async () => {
    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "inspect",
      "missing",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("assistant apps list");
  });
});

describe("assistant apps refresh", () => {
  test("sends apps_refresh IPC for a workspace app", async () => {
    const name = uniqueAppName("Refresh");
    const created = createApp({
      name,
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });

    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "refresh",
      created.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(lastIpcCall).toEqual({
      method: "apps_refresh",
      params: { pathParams: { id: created.id } },
    });
    const body = parseJson(result.stdout);
    expect(body.compiled).toBe(true);
  });

  test("sends apps_refresh IPC for a plugin app", async () => {
    const pluginName = `charts-${Math.random().toString(36).slice(2, 8)}`;
    const pluginDir = join(getWorkspacePluginsDir(), pluginName);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0" }),
    );
    mkdirSync(join(pluginDir, "apps", "viewer"), { recursive: true });
    writeFileSync(join(pluginDir, "apps", "viewer", "index.html"), "<h1></h1>");

    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "refresh",
      "viewer",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(lastIpcCall).toEqual({
      method: "apps_refresh",
      params: { pathParams: { id: `plugins~${pluginName}~viewer` } },
    });
  });

  test("exits 1 when compile fails", async () => {
    const name = uniqueAppName("Refresh Fail");
    const created = createApp({
      name,
      schemaJson: "{}",
      htmlDefinition: "<h1>Budget</h1>",
    });
    mockIpcResult = {
      ok: true,
      result: {
        ok: true,
        appId: created.id,
        name,
        compiled: false,
        compile_duration_ms: 8,
        compile_errors: [{ text: "Could not resolve foo" }],
      },
    };

    const result = await runCliCommand(registerAppsCommand, [
      "apps",
      "refresh",
      created.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const body = parseJson(result.stdout);
    expect(body.compiled).toBe(false);
  });
});
