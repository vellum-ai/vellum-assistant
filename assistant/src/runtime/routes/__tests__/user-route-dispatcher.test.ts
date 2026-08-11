/**
 * Dispatcher resolution & guards.
 *
 * The dispatcher's own responsibility is resolving a `/x/*` path to a handler
 * file (or 404), then handing it to the route host. These tests mock the host
 * client so they can assert *which* file was resolved and forwarded (or that the
 * request was rejected before the host was touched) without spawning a
 * subprocess. Handler execution semantics (200/405/throw/stall) are covered
 * end-to-end against the real worker in `routes/__tests__/route-host.test.ts`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RouteInvokeParams } from "../../../routes/route-host-protocol.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../../util/platform.js";

// ---------------------------------------------------------------------------
// Mock the route host client: record the resolved filePath the dispatcher
// forwards, and reply 200 so a resolved route is distinguishable from a 404.
// ---------------------------------------------------------------------------

const invokeCalls: RouteInvokeParams[] = [];

mock.module("../../../routes/route-host-client.js", () => ({
  RouteHostClient: class {
    async invoke(params: RouteInvokeParams) {
      invokeCalls.push(params);
      return { status: 200, headers: [], body: null };
    }
  },
  RouteHostTimeoutError: class extends Error {},
  RouteHostUnavailableError: class extends Error {},
}));

const { UserRouteDispatcher } = await import("../user-route-dispatcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatcher() {
  return new UserRouteDispatcher();
}

function makeRequest(
  method: string,
  path = "http://localhost/v1/x/test",
): Request {
  return new Request(path, { method });
}

/** The filePath the dispatcher forwarded to the host on the most recent invoke. */
function lastForwardedFile(): string | undefined {
  return invokeCalls.at(-1)?.filePath;
}

function writeHandler(
  relativePath: string,
  content = "export function GET() {}",
): string {
  const routesDir = getWorkspaceRoutesDir();
  const fullPath = join(routesDir, relativePath);
  mkdirSync(fullPath.substring(0, fullPath.lastIndexOf("/")), {
    recursive: true,
  });
  writeFileSync(fullPath, content);
  return fullPath;
}

function writePluginHandler(
  pluginName: string,
  relativePath: string,
  content = "export function GET() {}",
): string {
  const fullPath = join(
    getWorkspacePluginsDir(),
    pluginName,
    "routes",
    relativePath,
  );
  mkdirSync(fullPath.substring(0, fullPath.lastIndexOf("/")), {
    recursive: true,
  });
  writeFileSync(fullPath, content);
  return fullPath;
}

async function readErrorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return response.json();
}

beforeEach(() => {
  invokeCalls.length = 0;
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
});

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path traversal — rejected before resolution
// ---------------------------------------------------------------------------

describe("path traversal", () => {
  test("rejects paths containing '..' without touching the host", async () => {
    const res = await makeDispatcher().dispatch(
      "../etc/passwd",
      makeRequest("GET"),
    );
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Path traversal");
    expect(invokeCalls).toHaveLength(0);
  });

  test("rejects embedded '..' segments", async () => {
    const res = await makeDispatcher().dispatch(
      "foo/../../etc/passwd",
      makeRequest("GET"),
    );
    expect(res.status).toBe(400);
    expect(invokeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 404 — missing handler
// ---------------------------------------------------------------------------

describe("missing handler", () => {
  test("404s when no handler file exists, without touching the host", async () => {
    const res = await makeDispatcher().dispatch(
      "nonexistent",
      makeRequest("GET"),
    );
    expect(res.status).toBe(404);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("/x/nonexistent");
    expect(invokeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Workspace route resolution — the resolved file is forwarded to the host
// ---------------------------------------------------------------------------

describe("workspace route resolution", () => {
  test("resolves a direct .ts file", async () => {
    writeHandler("hello.ts");
    await makeDispatcher().dispatch("hello", makeRequest("GET"));
    expect(lastForwardedFile()?.endsWith("hello.ts")).toBe(true);
  });

  test("resolves a .js file", async () => {
    writeHandler("legacy.js");
    await makeDispatcher().dispatch("legacy", makeRequest("GET"));
    expect(lastForwardedFile()?.endsWith("legacy.js")).toBe(true);
  });

  test("resolves a directory to its index.ts", async () => {
    writeHandler("my-app/index.ts");
    await makeDispatcher().dispatch("my-app", makeRequest("GET"));
    expect(lastForwardedFile()?.endsWith(join("my-app", "index.ts"))).toBe(
      true,
    );
  });

  test("resolves a directory to index.js when no index.ts", async () => {
    writeHandler("fallback-app/index.js");
    await makeDispatcher().dispatch("fallback-app", makeRequest("GET"));
    expect(
      lastForwardedFile()?.endsWith(join("fallback-app", "index.js")),
    ).toBe(true);
  });

  test("prefers a direct file over the directory index", async () => {
    writeHandler("dual.ts");
    writeHandler("dual/index.ts");
    await makeDispatcher().dispatch("dual", makeRequest("GET"));
    expect(lastForwardedFile()?.endsWith("dual.ts")).toBe(true);
  });

  test("resolves nested subdirectory handlers", async () => {
    writeHandler("api/v1/status.ts");
    await makeDispatcher().dispatch("api/v1/status", makeRequest("GET"));
    expect(lastForwardedFile()?.endsWith(join("api", "v1", "status.ts"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin routes — /x/plugins/<name>/*
// ---------------------------------------------------------------------------

describe("plugin routes", () => {
  test("resolves a plugin's routes/ directory", async () => {
    writePluginHandler("my-plugin", "status.ts");
    await makeDispatcher().dispatch(
      "plugins/my-plugin/status",
      makeRequest("GET"),
    );
    expect(
      lastForwardedFile()?.endsWith(
        join("plugins", "my-plugin", "routes", "status.ts"),
      ),
    ).toBe(true);
  });

  test("resolves nested paths and the namespace-root index", async () => {
    writePluginHandler("my-plugin", "webhooks/incoming.ts");
    writePluginHandler("my-plugin", "index.ts");

    await makeDispatcher().dispatch(
      "plugins/my-plugin/webhooks/incoming",
      makeRequest("POST"),
    );
    expect(
      lastForwardedFile()?.endsWith(join("routes", "webhooks", "incoming.ts")),
    ).toBe(true);

    // `/x/plugins/my-plugin` (no sub-path) maps to the plugin's routes/index.
    await makeDispatcher().dispatch("plugins/my-plugin", makeRequest("GET"));
    expect(
      lastForwardedFile()?.endsWith(join("my-plugin", "routes", "index.ts")),
    ).toBe(true);
  });

  test("404s when the plugin route file does not exist", async () => {
    const res = await makeDispatcher().dispatch(
      "plugins/ghost-plugin/status",
      makeRequest("GET"),
    );
    expect(res.status).toBe(404);
    expect(invokeCalls).toHaveLength(0);
  });

  test("a plugin route is confined to its own plugin directory", async () => {
    // A workspace route literally named routes/plugins/foo must NOT answer a
    // request in the plugin namespace — the plugins/ prefix is reserved.
    writeHandler("plugins/foo.ts");
    const res = await makeDispatcher().dispatch(
      "plugins/foo",
      makeRequest("GET"),
    );
    expect(res.status).toBe(404);
    expect(invokeCalls).toHaveLength(0);
  });

  test("404s a bare /x/plugins with no plugin name", async () => {
    const res = await makeDispatcher().dispatch("plugins", makeRequest("GET"));
    expect(res.status).toBe(404);
    expect(invokeCalls).toHaveLength(0);
  });

  test("404s a disabled plugin's routes even though the files exist", async () => {
    writePluginHandler("off-plugin", "status.ts");

    // Enabled: resolved and forwarded.
    await makeDispatcher().dispatch(
      "plugins/off-plugin/status",
      makeRequest("GET"),
    );
    expect(lastForwardedFile()?.endsWith("status.ts")).toBe(true);

    // Drop the `.disabled` sentinel — the same toggle the CLI writes.
    writeFileSync(
      join(getWorkspacePluginsDir(), "off-plugin", ".disabled"),
      "",
    );

    const res = await makeDispatcher().dispatch(
      "plugins/off-plugin/status",
      makeRequest("GET"),
    );
    expect(res.status).toBe(404);
  });

  test("one plugin cannot serve another plugin's namespace", async () => {
    writePluginHandler("plugin-a", "status.ts");

    await makeDispatcher().dispatch(
      "plugins/plugin-a/status",
      makeRequest("GET"),
    );
    expect(lastForwardedFile()?.includes(join("plugin-a", "routes"))).toBe(
      true,
    );

    // plugin-b declared nothing, so its namespace 404s even for the same path.
    const other = await makeDispatcher().dispatch(
      "plugins/plugin-b/status",
      makeRequest("GET"),
    );
    expect(other.status).toBe(404);
  });
});
