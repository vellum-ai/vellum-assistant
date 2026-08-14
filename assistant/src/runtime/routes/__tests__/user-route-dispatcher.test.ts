import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  markPluginReady,
  resetPluginReadinessForTests,
} from "../../../plugins/plugin-readiness.js";
import {
  readPluginRouteManifest,
  resetPluginRouteManifestCacheForTests,
} from "../../../plugins/plugin-route-manifest.js";
// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../../util/platform.js";
import {
  type UserRouteDispatchContext,
  UserRouteDispatcher,
} from "../user-route-dispatcher.js";

const PLUGIN_ROUTE_CONTEXT_MODULE_URL = new URL(
  "../../../plugin-api/route-context.ts",
  import.meta.url,
).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a dispatcher with optional overrides. */
const LOCAL_DISPATCH_CONTEXT = {
  actor: {
    principalType: "local",
    principalId: null,
    scopes: ["local.all"],
  },
} as const satisfies UserRouteDispatchContext;

interface TestDispatcher {
  dispatch(
    routePath: string,
    request: Request,
    context?: UserRouteDispatchContext,
  ): Promise<Response>;
}

function makeDispatcher(options?: {
  handlerTimeoutMs?: number;
}): TestDispatcher {
  const dispatcher = new UserRouteDispatcher(options);
  return {
    dispatch(routePath, request, context = LOCAL_DISPATCH_CONTEXT) {
      return dispatcher.dispatch(routePath, request, context);
    },
  };
}

function makeRequest(
  method: string,
  path = "http://localhost/v1/x/test",
): Request {
  return new Request(path, { method });
}

function writeHandler(relativePath: string, content: string): string {
  const routesDir = getWorkspaceRoutesDir();
  const fullPath = join(routesDir, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

/** Write a route handler into a plugin's `routes/` directory. */
function writePluginHandler(
  pluginName: string,
  relativePath: string,
  content: string,
): string {
  const pluginDir = join(getWorkspacePluginsDir(), pluginName);
  const fullPath = join(pluginDir, "routes", relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: pluginName }),
  );
  writeFileSync(fullPath, content);
  markPluginReady(pluginName, "a".repeat(64));
  return fullPath;
}

function writePluginRouteManifest(
  pluginName: string,
  routes: Array<Record<string, unknown>>,
): void {
  const path = join(
    getWorkspacePluginsDir(),
    pluginName,
    "routes",
    "manifest.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, routes }));
  resetPluginRouteManifestCacheForTests();
}

async function readErrorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return response.json();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetPluginReadinessForTests();
  resetPluginRouteManifestCacheForTests();
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
});

afterEach(() => {
  resetPluginReadinessForTests();
  resetPluginRouteManifestCacheForTests();
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe("path traversal", () => {
  test("rejects paths containing '..'", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("../etc/passwd", makeRequest("GET"));
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Path traversal");
  });

  test("rejects embedded '..' segments", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "foo/../../etc/passwd",
      makeRequest("GET"),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 404 — missing handler
// ---------------------------------------------------------------------------

describe("missing handler", () => {
  test("returns 404 when no handler file exists", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("nonexistent", makeRequest("GET"));
    expect(res.status).toBe(404);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("/x/nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Successful dispatch
// ---------------------------------------------------------------------------

describe("successful dispatch", () => {
  test("dispatches GET to handler exporting GET function", async () => {
    writeHandler(
      "hello.ts",
      `export function GET(request) {
        return Response.json({ greeting: "hello" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("hello", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.greeting).toBe("hello");
  });

  test("dispatches POST to handler exporting POST function", async () => {
    writeHandler(
      "submit.ts",
      `export async function POST(request) {
        return Response.json({ received: true }, { status: 201 });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("submit", makeRequest("POST"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  test("dispatches to .js handler files", async () => {
    writeHandler(
      "legacy.js",
      `export function GET(request) {
        return Response.json({ format: "js" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("legacy", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("js");
  });
});

// ---------------------------------------------------------------------------
// Workspace route authorization
// ---------------------------------------------------------------------------

describe("workspace route authorization", () => {
  test("requires settings.read or local.all before importing the handler", async () => {
    const importMarker = join(getWorkspaceRoutesDir(), "imported");
    writeHandler(
      "protected.ts",
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(importMarker)}, "yes");
       export function GET() { return Response.json({ ok: true }); }`,
    );
    const dispatcher = makeDispatcher();

    const denied = await dispatcher.dispatch("protected", makeRequest("GET"), {
      actor: {
        principalType: "actor",
        principalId: "user-123",
        scopes: ["chat.read"],
      },
    });

    expect(denied.status).toBe(403);
    expect(existsSync(importMarker)).toBe(false);

    const settingsReader = await dispatcher.dispatch(
      "protected",
      makeRequest("GET"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.read"],
        },
      },
    );
    expect(settingsReader.status).toBe(200);
    expect(existsSync(importMarker)).toBe(true);

    const localCaller = await dispatcher.dispatch(
      "protected",
      makeRequest("GET"),
      {
        actor: {
          principalType: "local",
          principalId: null,
          scopes: ["local.all"],
        },
      },
    );
    expect(localCaller.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Index file convention
// ---------------------------------------------------------------------------

describe("index file convention", () => {
  test("resolves directory to index.ts", async () => {
    writeHandler(
      "my-app/index.ts",
      `export function GET(request) {
        return Response.json({ index: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("my-app", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBe(true);
  });

  test("resolves directory to index.js when no index.ts", async () => {
    writeHandler(
      "fallback-app/index.js",
      `export function GET(request) {
        return Response.json({ index: "js" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("fallback-app", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBe("js");
  });

  test("prefers direct file over index file", async () => {
    writeHandler(
      "dual.ts",
      `export function GET(request) {
        return Response.json({ source: "direct" });
      }`,
    );
    writeHandler(
      "dual/index.ts",
      `export function GET(request) {
        return Response.json({ source: "index" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("dual", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// 405 — method not allowed
// ---------------------------------------------------------------------------

describe("method not allowed", () => {
  test("returns 405 with Allow header when method not exported", async () => {
    writeHandler(
      "get-only.ts",
      `export function GET(request) {
        return Response.json({ ok: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("get-only", makeRequest("POST"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  test("lists multiple allowed methods in Allow header", async () => {
    writeHandler(
      "multi.ts",
      `export function GET(request) { return new Response("ok"); }
       export function POST(request) { return new Response("ok"); }
       export function DELETE(request) { return new Response("ok"); }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("multi", makeRequest("PUT"));
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow");
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).toContain("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Handler timeout
// ---------------------------------------------------------------------------

describe("handler timeout", () => {
  test("returns 504 when handler exceeds timeout", async () => {
    writeHandler(
      "slow.ts",
      `export function GET(request) {
        return new Promise(() => {});
      }`,
    );

    // Use a very short timeout for testing
    const dispatcher = makeDispatcher({ handlerTimeoutMs: 50 });
    const res = await dispatcher.dispatch("slow", makeRequest("GET"));
    expect(res.status).toBe(504);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Handler errors
// ---------------------------------------------------------------------------

describe("handler errors", () => {
  test("returns 500 when handler throws synchronously", async () => {
    writeHandler(
      "throws.ts",
      `export function GET(request) {
        throw new Error("boom");
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("throws", makeRequest("GET"));
    expect(res.status).toBe(500);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("boom");
  });

  test("returns 500 when handler rejects", async () => {
    writeHandler(
      "rejects.ts",
      `export async function GET(request) {
        throw new Error("async boom");
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("rejects", makeRequest("GET"));
    expect(res.status).toBe(500);
    const body = await readErrorBody(res);
    expect(body.error.message).toBe("async boom");
  });
});

// ---------------------------------------------------------------------------
// Mtime-based cache invalidation
// ---------------------------------------------------------------------------

describe("mtime cache", () => {
  test("serves updated content after file modification", async () => {
    const filePath = writeHandler(
      "mutable.ts",
      `export function GET(request) {
        return Response.json({ version: 1 });
      }`,
    );

    const dispatcher = makeDispatcher();

    // First request — version 1
    const res1 = await dispatcher.dispatch("mutable", makeRequest("GET"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.version).toBe(1);

    // Wait briefly to ensure mtime changes, then rewrite
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(
      filePath,
      `export function GET(request) {
        return Response.json({ version: 2 });
      }`,
    );

    // Second request — should pick up version 2
    const res2 = await dispatcher.dispatch("mutable", makeRequest("GET"));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Subdirectory routing
// ---------------------------------------------------------------------------

describe("subdirectory routing", () => {
  test("dispatches to nested handler files", async () => {
    writeHandler(
      "api/v1/status.ts",
      `export function GET(request) {
        return Response.json({ nested: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("api/v1/status", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Description metadata
// ---------------------------------------------------------------------------

describe("description metadata", () => {
  test("ignores non-handler exports without affecting dispatch", async () => {
    writeHandler(
      "with-meta.ts",
      `export const description = "A test handler";
       export function GET(request) {
         return Response.json({ ok: true });
       }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("with-meta", makeRequest("GET"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Handler signature
// ---------------------------------------------------------------------------

describe("handler signature", () => {
  test("passes the request and the deprecated context shim", async () => {
    writeHandler(
      "ctx-shape.ts",
      `export function GET(request, context) {
        return Response.json({
          argCount: arguments.length,
          method: request.method,
          hasPublish: typeof context?.assistantEventHub?.publish === "function",
          hasPostMessage:
            typeof context?.conversations?.postMessage === "function",
        });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("ctx-shape", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.argCount).toBe(2);
    expect(body.method).toBe("GET");
    expect(body.hasPublish).toBe(true);
    expect(body.hasPostMessage).toBe(true);
  });

  test("a handler that ignores the context still works", async () => {
    writeHandler(
      "req-only.ts",
      `export function GET(request) {
        return Response.json({ ok: true, method: request.method });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("req-only", makeRequest("GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plugin routes — /x/plugins/<name>/*
// ---------------------------------------------------------------------------

describe("plugin routes", () => {
  test("dispatches to a plugin's routes/ directory", async () => {
    writePluginHandler(
      "my-plugin",
      "status.ts",
      `export function GET(request) {
        return Response.json({ plugin: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "plugins/my-plugin/status",
      makeRequest("GET"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugin).toBe(true);
  });

  test("requires write scope for legacy mutating routes", async () => {
    writePluginHandler(
      "legacy-post",
      "submit.ts",
      `export function POST() { return new Response("ok"); }`,
    );

    const response = await makeDispatcher().dispatch(
      "plugins/legacy-post/submit",
      makeRequest("POST"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.read"],
        },
      },
    );

    expect(response.status).toBe(403);

    const allowed = await makeDispatcher().dispatch(
      "plugins/legacy-post/submit",
      makeRequest("POST"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.write"],
        },
      },
    );
    expect(allowed.status).toBe(200);
  });

  test("fails closed without verified dispatch context", async () => {
    writePluginHandler(
      "missing-context",
      "status.ts",
      `export function GET() { return new Response("unexpected"); }`,
    );
    const dispatcher = new UserRouteDispatcher();

    const response = await (
      dispatcher.dispatch as unknown as (
        routePath: string,
        request: Request,
      ) => Promise<Response>
    )("plugins/missing-context/status", makeRequest("GET"));

    expect(response.status).toBe(403);
  });

  test("resolves nested paths and the index (namespace root)", async () => {
    writePluginHandler(
      "my-plugin",
      "webhooks/incoming.ts",
      `export function POST(request) { return Response.json({ nested: true }); }`,
    );
    writePluginHandler(
      "my-plugin",
      "index.ts",
      `export function GET(request) { return Response.json({ root: true }); }`,
    );

    const dispatcher = makeDispatcher();

    const nested = await dispatcher.dispatch(
      "plugins/my-plugin/webhooks/incoming",
      makeRequest("POST"),
    );
    expect(nested.status).toBe(200);
    expect((await nested.json()).nested).toBe(true);

    // `/x/plugins/my-plugin` (no sub-path) maps to the plugin's routes/index.
    const root = await dispatcher.dispatch(
      "plugins/my-plugin",
      makeRequest("GET"),
    );
    expect(root.status).toBe(200);
    expect((await root.json()).root).toBe(true);
  });

  test("404s when the plugin route file does not exist", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "plugins/ghost-plugin/status",
      makeRequest("GET"),
    );
    expect(res.status).toBe(404);
  });

  test("a plugin route is confined to its own plugin directory", async () => {
    // A workspace route literally named routes/plugins/foo must NOT answer a
    // request in the plugin namespace — the plugins/ prefix is reserved.
    writeHandler(
      "plugins/foo.ts",
      `export function GET(request) { return Response.json({ workspace: true }); }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("plugins/foo", makeRequest("GET"));
    // Resolves against <workspace>/plugins/foo/routes/index (absent) → 404,
    // never the workspace routes/plugins/foo.ts handler.
    expect(res.status).toBe(404);
  });

  test("404s a bare /x/plugins with no plugin name", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("plugins", makeRequest("GET"));
    expect(res.status).toBe(404);
  });

  test("404s a disabled plugin's routes even though the files exist", async () => {
    writePluginHandler(
      "off-plugin",
      "status.ts",
      `export function GET(request) { return Response.json({ ok: true }); }`,
    );
    const dispatcher = makeDispatcher();

    // Enabled: served.
    const enabled = await dispatcher.dispatch(
      "plugins/off-plugin/status",
      makeRequest("GET"),
    );
    expect(enabled.status).toBe(200);

    // Drop the `.disabled` sentinel — the same toggle the CLI writes.
    writeFileSync(
      join(getWorkspacePluginsDir(), "off-plugin", ".disabled"),
      "",
    );

    const disabled = await dispatcher.dispatch(
      "plugins/off-plugin/status",
      makeRequest("GET"),
    );
    expect(disabled.status).toBe(404);
  });

  test("one plugin cannot serve another plugin's namespace", async () => {
    writePluginHandler(
      "plugin-a",
      "status.ts",
      `export function GET(request) { return Response.json({ owner: "a" }); }`,
    );

    const dispatcher = makeDispatcher();
    const mine = await dispatcher.dispatch(
      "plugins/plugin-a/status",
      makeRequest("GET"),
    );
    expect(mine.status).toBe(200);
    // plugin-b declared nothing, so its namespace 404s even for the same path.
    const other = await dispatcher.dispatch(
      "plugins/plugin-b/status",
      makeRequest("GET"),
    );
    expect(other.status).toBe(404);
  });

  test("does not execute routes from a directory without package metadata", async () => {
    const pluginDir = join(getWorkspacePluginsDir(), "uninstalled-plugin");
    const marker = join(pluginDir, "imported");
    mkdirSync(join(pluginDir, "routes"), { recursive: true });
    writeFileSync(
      join(pluginDir, "routes", "status.ts"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(marker)}, "yes");
       export function GET() { return new Response("unexpected"); }`,
    );

    const response = await makeDispatcher().dispatch(
      "plugins/uninstalled-plugin/status",
      makeRequest("GET"),
    );

    expect(response.status).toBe(404);
    expect(existsSync(marker)).toBe(false);
  });

  test("reloads a same-size route manifest with preserved mtime", () => {
    const plugin = "manifest-replacement";
    writePluginRouteManifest(plugin, [
      {
        path: "status",
        method: "GET",
        authorization: {
          principal: "actor",
          requiredScopes: ["settings.write"],
        },
      },
    ]);
    const manifestPath = join(
      getWorkspacePluginsDir(),
      plugin,
      "routes",
      "manifest.json",
    );
    const first = readPluginRouteManifest(
      join(getWorkspacePluginsDir(), plugin),
    );
    const before = statSync(manifestPath);
    const replacement = JSON.stringify({
      schemaVersion: 1,
      routes: [
        {
          path: "status",
          method: "PUT",
          authorization: {
            principal: "actor",
            requiredScopes: ["settings.write"],
          },
        },
      ],
    });
    expect(Buffer.byteLength(replacement)).toBe(before.size);

    writeFileSync(manifestPath, replacement);
    utimesSync(manifestPath, before.atime, before.mtime);
    const second = readPluginRouteManifest(
      join(getWorkspacePluginsDir(), plugin),
    );

    expect(first.kind).toBe("valid");
    expect(second.kind).toBe("valid");
    if (second.kind === "valid") {
      expect(second.manifest.routes[0]?.method).toBe("PUT");
    }
  });

  test("denies a read-only actor on a declared write route before import", async () => {
    const plugin = "write-policy";
    const importMarker = join(getWorkspacePluginsDir(), plugin, "imported");
    writePluginHandler(
      plugin,
      "settings.ts",
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(importMarker)}, "yes");
       export function PATCH() { return Response.json({ ok: true }); }`,
    );
    writePluginRouteManifest(plugin, [
      {
        path: "settings",
        method: "PATCH",
        authorization: {
          principal: "actor",
          requiredScopes: ["settings.write"],
        },
      },
    ]);
    markPluginReady(plugin, "a".repeat(64));

    const response = await makeDispatcher().dispatch(
      `plugins/${plugin}/settings`,
      makeRequest("PATCH"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.read"],
        },
      },
    );

    expect(response.status).toBe(403);
    expect(existsSync(importMarker)).toBe(false);
  });

  test("exposes host-derived route context to an authorized handler", async () => {
    const plugin = "route-context";
    writePluginHandler(
      plugin,
      "settings.ts",
      `import { requirePluginRouteContext } from ${JSON.stringify(PLUGIN_ROUTE_CONTEXT_MODULE_URL)};
       export async function PATCH() {
         const context = requirePluginRouteContext();
         return Response.json({
           pluginId: context.pluginId,
           principalId: context.actor.principalId,
           requestId: context.requestId,
           hasSignal: context.signal instanceof AbortSignal,
           storageDir: await context.host.getPluginStorageDir(),
         });
       }`,
    );
    writePluginRouteManifest(plugin, [
      {
        path: "settings",
        method: "PATCH",
        authorization: {
          principal: "actor",
          requiredScopes: ["settings.write"],
        },
      },
    ]);
    markPluginReady(plugin, "b".repeat(64));

    const response = await makeDispatcher().dispatch(
      `plugins/${plugin}/settings`,
      makeRequest("PATCH"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.write"],
        },
        requestId: "request-123",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pluginId: plugin,
      principalId: "user-123",
      requestId: "request-123",
      hasSignal: true,
      storageDir: join(getWorkspacePluginsDir(), plugin, "data"),
    });
  });

  test("keeps actor and assistant-peer route policies disjoint", async () => {
    const plugin = "peer-policy";
    writePluginHandler(
      plugin,
      "exchange.ts",
      `import { requirePluginRouteContext } from ${JSON.stringify(PLUGIN_ROUTE_CONTEXT_MODULE_URL)};
       export function POST() {
         return Response.json(requirePluginRouteContext().verifiedPeer);
       }`,
    );
    writePluginRouteManifest(plugin, [
      {
        path: "exchange",
        method: "POST",
        authorization: {
          principal: "assistant_peer",
          operationKinds: ["conversation.copy"],
        },
      },
    ]);
    markPluginReady(plugin, "c".repeat(64));

    const actorResponse = await makeDispatcher().dispatch(
      `plugins/${plugin}/exchange`,
      makeRequest("POST"),
      {
        actor: {
          principalType: "actor",
          principalId: "user-123",
          scopes: ["settings.write"],
        },
      },
    );
    expect(actorResponse.status).toBe(403);

    const verifiedPeer = {
      peerId: "peer-123",
      generation: "generation-1",
      operation: {
        id: "operation-123",
        kind: "conversation.copy",
        payloadHash: `sha256:${"d".repeat(64)}`,
      },
    } as const;
    const peerResponse = await makeDispatcher().dispatch(
      `plugins/${plugin}/exchange`,
      makeRequest("POST"),
      {
        actor: {
          principalType: "assistant_peer",
          principalId: null,
          scopes: [],
        },
        verifiedPeer,
      },
    );
    expect(peerResponse.status).toBe(200);
    expect(await peerResponse.json()).toEqual(verifiedPeer);
  });

  test("a new route export is not bound to a stale helper after upgrade", async () => {
    // Reproduces the browser plugin 500: `/frame` loaded `src/http.ts`
    // first, then an upgrade added `requireNumber` to http.ts and a new
    // `/input` that imports it. Cache-busting only the entry file rebound
    // input.ts to the cached http.ts, which had no such export.
    const plugin = "stale-helper";
    const helperPath = join(getWorkspacePluginsDir(), plugin, "src", "http.ts");
    mkdirSync(dirname(helperPath), { recursive: true });
    writeFileSync(helperPath, `export function label() { return "v1"; }\n`);
    writePluginHandler(
      plugin,
      "frame.ts",
      `import { label } from "../src/http.js";
       export function GET() { return Response.json({ label: label() }); }`,
    );
    writePluginHandler(
      plugin,
      "input.ts",
      `import { label } from "../src/http.js";
       export function POST() { return Response.json({ label: label() }); }`,
    );

    const dispatcher = makeDispatcher();
    const frame1 = await dispatcher.dispatch(
      `plugins/${plugin}/frame`,
      makeRequest("GET"),
    );
    expect(frame1.status).toBe(200);
    expect((await frame1.json()).label).toBe("v1");

    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(
      helperPath,
      `export function label() { return "v2"; }
       export function extra() { return true; }\n`,
    );
    writePluginHandler(
      plugin,
      "input.ts",
      `import { extra } from "../src/http.js";
       export function POST() { return Response.json({ extra: extra() }); }`,
    );

    const input = await dispatcher.dispatch(
      `plugins/${plugin}/input`,
      makeRequest("POST"),
    );
    expect(input.status).toBe(200);
    expect((await input.json()).extra).toBe(true);

    const frame2 = await dispatcher.dispatch(
      `plugins/${plugin}/frame`,
      makeRequest("GET"),
    );
    expect(frame2.status).toBe(200);
    expect((await frame2.json()).label).toBe("v2");
  });
});
