/**
 * Default-plugin route resolution: a first-party default plugin's routes are
 * served in the `/x/plugins/<name>/` namespace from the app source tree
 * (`plugins/defaults/<dir>/routes/`), where `<name>` is the plugin's
 * `default-…` MANIFEST name (e.g. `default-platform-hosted`) — the same name
 * its `.disabled` sentinel is keyed by — not its bare directory name. An
 * installed workspace plugin of the same name overrides the default.
 *
 * These tests exercise the real `platform-hosted` default plugin (manifest name
 * `default-platform-hosted`), which ships `routes/reengage.ts`, a POST-only
 * handler. A GET reaches the resolved source file and 405s — proving
 * resolution + source-tree module load without running the handler's heavy
 * background-turn logic.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  getDefaultPluginManifestName,
  getDefaultPluginRouteRoots,
  getDefaultPluginRoutesDir,
} from "../../../plugins/defaults/main.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import type { UserRouteContext } from "../user-route-dispatcher.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";
import {
  isRouteTestPath,
  listPluginRouteRoots,
  resolveHandlerFile,
  resolveRouteLocation,
} from "../user-route-resolution.js";

/** The default plugin's source directory name. */
const DEFAULT_PLUGIN_DIR = "platform-hosted";
/** Its route namespace = its `default-…` manifest name. */
const DEFAULT_PLUGIN = getDefaultPluginManifestName(DEFAULT_PLUGIN_DIR)!;

function makeDispatcher(): UserRouteDispatcher {
  const context: UserRouteContext = {
    assistantEventHub: new AssistantEventHub(),
    conversations: { postMessage: async () => ({ messageId: "m" }) },
  };
  return new UserRouteDispatcher({ context });
}

/** Create a workspace plugin dir; returns its `routes/` dir. Cleaned up per test. */
function writeWorkspacePluginHandler(
  pluginName: string,
  relativePath: string,
  content: string,
): void {
  const full = join(
    getWorkspacePluginsDir(),
    pluginName,
    "routes",
    relativePath,
  );
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  for (const name of [DEFAULT_PLUGIN, DEFAULT_PLUGIN_DIR]) {
    rmSync(join(getWorkspacePluginsDir(), name), {
      recursive: true,
      force: true,
    });
  }
});

describe("default plugin route source resolution", () => {
  test("getDefaultPluginRoutesDir returns the source routes dir for a default plugin's manifest name", () => {
    const dir = getDefaultPluginRoutesDir(DEFAULT_PLUGIN);
    expect(dir).not.toBeNull();
    expect(
      dir!.endsWith(join("plugins", "defaults", DEFAULT_PLUGIN_DIR, "routes")),
    ).toBe(true);
    expect(existsSync(dir!)).toBe(true);
  });

  test("getDefaultPluginRoutesDir returns null for the bare directory name, unknown names, and path traversal", () => {
    // The bare dir name is no longer a route namespace — only the manifest name.
    expect(getDefaultPluginRoutesDir(DEFAULT_PLUGIN_DIR)).toBeNull();
    expect(getDefaultPluginRoutesDir("definitely-not-a-plugin")).toBeNull();
    expect(getDefaultPluginRoutesDir("../util")).toBeNull();
    expect(getDefaultPluginRoutesDir("..")).toBeNull();
  });

  test("getDefaultPluginRouteRoots includes the platform-hosted plugin under its manifest name", () => {
    const roots = getDefaultPluginRouteRoots();
    const entry = roots.find((r) => r.pluginName === DEFAULT_PLUGIN);
    expect(entry).toBeDefined();
    expect(existsSync(entry!.routesDir)).toBe(true);
  });

  test("resolveRouteLocation maps the namespace to the source tree and finds the handler", () => {
    const location = resolveRouteLocation(`plugins/${DEFAULT_PLUGIN}/reengage`);
    expect(location).not.toBeNull();
    expect(location!.routesDir).toBe(
      getDefaultPluginRoutesDir(DEFAULT_PLUGIN)!,
    );
    expect(location!.subPath).toBe("reengage");

    const handlerFile = resolveHandlerFile(location!.routesDir, "reengage");
    expect(handlerFile).not.toBeNull();
    expect(handlerFile!.endsWith(join("reengage.ts"))).toBe(true);
  });

  test("listPluginRouteRoots includes default plugins under their manifest name", () => {
    const roots = listPluginRouteRoots();
    expect(roots.some((r) => r.pluginName === DEFAULT_PLUGIN)).toBe(true);
  });

  test("does not advertise memory (its ROUTES modules live in src/, not routes/)", () => {
    // memory's shared-table `RouteDefinition` modules are internal (registered
    // into the /v1 table), not userland `/x/plugins/default-memory/*` handlers,
    // so the source-tree fallback must not surface them.
    expect(getDefaultPluginRoutesDir("default-memory")).not.toBeNull();
    expect(existsSync(getDefaultPluginRoutesDir("default-memory")!)).toBe(
      false,
    );
    expect(
      getDefaultPluginRouteRoots().some(
        (r) => r.pluginName === "default-memory",
      ),
    ).toBe(false);
    expect(
      listPluginRouteRoots().some((r) => r.pluginName === "default-memory"),
    ).toBe(false);
  });
});

describe("default plugin route dispatch", () => {
  test("serves the default plugin's source route (GET on a POST-only handler → 405)", async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      `plugins/${DEFAULT_PLUGIN}/reengage`,
      new Request(`http://localhost/v1/x/plugins/${DEFAULT_PLUGIN}/reengage`, {
        method: "GET",
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  test("honors the manifest-name .disabled sentinel", async () => {
    // A default plugin's namespace IS its manifest name, so the sentinel the
    // CLI/bootstrap write (`<workspace>/plugins/<manifest-name>/.disabled`)
    // gates it directly.
    const pluginDir = join(getWorkspacePluginsDir(), DEFAULT_PLUGIN);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".disabled"), "");

    expect(
      resolveRouteLocation(`plugins/${DEFAULT_PLUGIN}/reengage`),
    ).toBeNull();
    expect(
      listPluginRouteRoots().some((r) => r.pluginName === DEFAULT_PLUGIN),
    ).toBe(false);

    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      `plugins/${DEFAULT_PLUGIN}/reengage`,
      new Request(`http://localhost/v1/x/plugins/${DEFAULT_PLUGIN}/reengage`, {
        method: "GET",
      }),
    );
    expect(response.status).toBe(404);
  });

  test("an installed workspace plugin overrides the default of the same namespace", async () => {
    writeWorkspacePluginHandler(
      DEFAULT_PLUGIN,
      "reengage.ts",
      `export const GET = () => Response.json({ source: "workspace" });`,
    );

    const location = resolveRouteLocation(`plugins/${DEFAULT_PLUGIN}/reengage`);
    expect(location!.routesDir).toBe(
      join(getWorkspacePluginsDir(), DEFAULT_PLUGIN, "routes"),
    );

    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      `plugins/${DEFAULT_PLUGIN}/reengage`,
      new Request(`http://localhost/v1/x/plugins/${DEFAULT_PLUGIN}/reengage`, {
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "workspace" });
  });

  test("never dispatches test files or __tests__ paths (mock.module containment)", async () => {
    // Importing a test file into the live daemon executes its process-global
    // mock.module calls, replacing production modules. Dispatch must 404
    // without importing the file.
    writeWorkspacePluginHandler(
      DEFAULT_PLUGIN,
      "poison.test.ts",
      `export const GET = () => Response.json({ imported: true });`,
    );
    writeWorkspacePluginHandler(
      DEFAULT_PLUGIN,
      "__tests__/poison.ts",
      `export const GET = () => Response.json({ imported: true });`,
    );

    const routesDir = join(getWorkspacePluginsDir(), DEFAULT_PLUGIN, "routes");
    expect(resolveHandlerFile(routesDir, "poison.test")).toBeNull();
    expect(resolveHandlerFile(routesDir, "__tests__/poison")).toBeNull();

    const dispatcher = makeDispatcher();
    for (const path of ["poison.test", "__tests__/poison"]) {
      const response = await dispatcher.dispatch(
        `plugins/${DEFAULT_PLUGIN}/${path}`,
        new Request(`http://localhost/v1/x/plugins/${DEFAULT_PLUGIN}/${path}`, {
          method: "GET",
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  test("tripwire: no default plugin ships test files under its routes/ dir", () => {
    // Everything under a default plugin's routes/ is served from the source
    // tree and dynamically imported by discovery — test files belong in src/
    // or a __tests__ dir outside routes/.
    const offenders: string[] = [];
    const walk = (dir: string, routesDir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (isRouteTestPath(relative(routesDir, fullPath))) {
          offenders.push(fullPath);
        } else if (entry.isDirectory()) {
          walk(fullPath, routesDir);
        }
      }
    };
    for (const { routesDir } of getDefaultPluginRouteRoots()) {
      walk(routesDir, routesDir);
    }
    expect(offenders).toEqual([]);
  });
});
