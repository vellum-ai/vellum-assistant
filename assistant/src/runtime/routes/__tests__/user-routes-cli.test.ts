/**
 * Tests for the `assistant routes` discovery handlers (`user_routes_list`,
 * `user_routes_inspect`).
 *
 * These assert the CLI's view of the route surface matches what the dispatcher
 * serves: workspace routes appear at `/x/<path>`, plugin routes at
 * `/x/plugins/<name>/<path>`, files shadowed by the reserved plugin prefix are
 * excluded, and disabled plugins contribute nothing. Both handlers resolve
 * through the shared `user-route-resolution` module the dispatcher uses.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../../util/platform.js";
import type { RouteHandlerArgs } from "../types.js";
import { ROUTES } from "../user-routes-cli.js";

interface RouteEntry {
  routePath: string;
  methods: string[];
  filePath: string;
}

const listHandler = ROUTES.find((r) => r.operationId === "user_routes_list")!
  .handler as () => Promise<{ ok: true; routes: RouteEntry[] }>;
const inspectHandler = ROUTES.find(
  (r) => r.operationId === "user_routes_inspect",
)!.handler as (args: RouteHandlerArgs) => Promise<{ route: RouteEntry }>;

const GET_HANDLER = `export async function GET() { return Response.json({ ok: true }); }\n`;

function writeWorkspaceRoute(relPath: string): void {
  const full = join(getWorkspaceRoutesDir(), relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, GET_HANDLER);
}

function writePluginRoute(plugin: string, relPath: string): void {
  const full = join(getWorkspacePluginsDir(), plugin, "routes", relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, GET_HANDLER);
}

function disablePlugin(plugin: string): void {
  writeFileSync(join(getWorkspacePluginsDir(), plugin, ".disabled"), "");
}

beforeEach(() => {
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
  mkdirSync(getWorkspacePluginsDir(), { recursive: true });
});

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
});

describe("routes list", () => {
  test("lists workspace routes and plugin routes together", async () => {
    writeWorkspaceRoute("ping.ts");
    writePluginRoute("demo", "status.ts");
    writePluginRoute("demo", "webhooks/incoming.ts");
    writePluginRoute("demo", "index.ts");

    const { routes } = await listHandler();
    const byPath = new Map(routes.map((r) => [r.routePath, r]));

    expect(byPath.has("/x/ping")).toBe(true);
    expect(byPath.get("/x/ping")!.filePath).toBe("routes/ping.ts");

    expect(byPath.has("/x/plugins/demo/status")).toBe(true);
    expect(byPath.get("/x/plugins/demo/status")!.filePath).toBe(
      "plugins/demo/routes/status.ts",
    );
    expect(byPath.has("/x/plugins/demo/webhooks/incoming")).toBe(true);
    // routes/index.ts maps to the plugin namespace root.
    expect(byPath.has("/x/plugins/demo")).toBe(true);
  });

  test("excludes workspace files shadowed by the reserved plugin prefix", async () => {
    writeWorkspaceRoute("ping.ts");
    // A workspace file under routes/plugins/ is unreachable (the dispatcher
    // routes /x/plugins/* to plugin dirs), so it must not be listed.
    writeWorkspaceRoute("plugins/foo.ts");

    const { routes } = await listHandler();
    const paths = routes.map((r) => r.routePath);

    expect(paths).toContain("/x/ping");
    expect(paths).not.toContain("/x/plugins/foo");
  });

  test("excludes disabled plugins' routes", async () => {
    writePluginRoute("live", "status.ts");
    writePluginRoute("dead", "status.ts");
    disablePlugin("dead");

    const { routes } = await listHandler();
    const paths = routes.map((r) => r.routePath);

    expect(paths).toContain("/x/plugins/live/status");
    expect(paths).not.toContain("/x/plugins/dead/status");
  });
});

describe("routes inspect", () => {
  test("inspects a plugin route by sub-path and by /x/-prefixed path", async () => {
    writePluginRoute("demo", "status.ts");

    const bare = await inspectHandler({
      body: { path: "plugins/demo/status" },
    });
    expect(bare.route.routePath).toBe("/x/plugins/demo/status");
    expect(bare.route.methods).toEqual(["GET"]);
    expect(bare.route.filePath).toBe("plugins/demo/routes/status.ts");

    // The `/x/`-prefixed form that `routes list` prints is accepted too.
    const prefixed = await inspectHandler({
      body: { path: "/x/plugins/demo/status" },
    });
    expect(prefixed.route.routePath).toBe("/x/plugins/demo/status");
  });

  test("inspects a workspace route", async () => {
    writeWorkspaceRoute("ping.ts");
    const res = await inspectHandler({ body: { path: "ping" } });
    expect(res.route.routePath).toBe("/x/ping");
    expect(res.route.filePath).toBe("routes/ping.ts");
  });

  test("404s a shadowed, missing, or disabled route", async () => {
    writeWorkspaceRoute("plugins/foo.ts"); // shadowed workspace file
    writePluginRoute("dead", "status.ts");
    disablePlugin("dead");

    // Shadowed: resolves to plugin "foo" (which has no routes dir) → not found.
    await expect(
      inspectHandler({ body: { path: "plugins/foo" } }),
    ).rejects.toThrow();
    // Missing plugin.
    await expect(
      inspectHandler({ body: { path: "plugins/ghost/status" } }),
    ).rejects.toThrow();
    // Disabled plugin.
    await expect(
      inspectHandler({ body: { path: "plugins/dead/status" } }),
    ).rejects.toThrow();
  });
});
