/**
 * Default-plugin route resolution: a first-party default plugin's routes are
 * served in the `/x/plugins/<name>/` namespace from the app source tree
 * (`plugins/defaults/<name>/routes/`), not the workspace. An installed
 * workspace plugin of the same name overrides the default.
 *
 * These tests exercise the real `platform-hosted` default plugin (which ships
 * `routes/reengage.ts`, a POST-only handler). A GET reaches the resolved
 * source file and 405s — proving resolution + source-tree module load without
 * running the handler's heavy background-turn logic.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  getDefaultPluginRouteRoots,
  getDefaultPluginRoutesDir,
} from "../../../plugins/defaults/main.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import type { UserRouteContext } from "../user-route-dispatcher.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";
import {
  listPluginRouteRoots,
  resolveHandlerFile,
  resolveRouteLocation,
} from "../user-route-resolution.js";

const DEFAULT_PLUGIN = "platform-hosted";

function makeDispatcher(): UserRouteDispatcher {
  const context: UserRouteContext = {
    assistantEventHub: new AssistantEventHub(),
    assistantId: "test-assistant",
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
  rmSync(join(getWorkspacePluginsDir(), DEFAULT_PLUGIN), {
    recursive: true,
    force: true,
  });
});

describe("default plugin route source resolution", () => {
  test("getDefaultPluginRoutesDir returns the source routes dir for a default plugin", () => {
    const dir = getDefaultPluginRoutesDir(DEFAULT_PLUGIN);
    expect(dir).not.toBeNull();
    expect(
      dir!.endsWith(join("plugins", "defaults", DEFAULT_PLUGIN, "routes")),
    ).toBe(true);
    expect(existsSync(dir!)).toBe(true);
  });

  test("getDefaultPluginRoutesDir returns null for unknown names and path traversal", () => {
    expect(getDefaultPluginRoutesDir("definitely-not-a-plugin")).toBeNull();
    expect(getDefaultPluginRoutesDir("../util")).toBeNull();
    expect(getDefaultPluginRoutesDir("..")).toBeNull();
  });

  test("getDefaultPluginRouteRoots includes the platform-hosted plugin", () => {
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

  test("listPluginRouteRoots includes default plugins", () => {
    const roots = listPluginRouteRoots();
    expect(roots.some((r) => r.pluginName === DEFAULT_PLUGIN)).toBe(true);
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

  test("a disabled default plugin serves no routes (404)", async () => {
    // The `.disabled` sentinel lives in the workspace plugins dir even for
    // default plugins (the shared enabled/disabled source of truth).
    const pluginDir = join(getWorkspacePluginsDir(), DEFAULT_PLUGIN);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, ".disabled"), "");

    expect(
      resolveRouteLocation(`plugins/${DEFAULT_PLUGIN}/reengage`),
    ).toBeNull();

    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      `plugins/${DEFAULT_PLUGIN}/reengage`,
      new Request(`http://localhost/v1/x/plugins/${DEFAULT_PLUGIN}/reengage`, {
        method: "GET",
      }),
    );
    expect(response.status).toBe(404);
  });

  test("an installed workspace plugin overrides the default of the same name", async () => {
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
});
