/**
 * Tests for app pinning across the app-management routes.
 *
 * Covers the two things the client depends on that the pin store alone cannot
 * show: that a pin reaches the client on the app list rather than on a call of
 * its own, and that deleting an app takes its pin with it.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const publishCalls: unknown[] = [];

mock.module("../../sync/resource-sync-events.js", () => ({
  publishAppsChanged: (originClientId?: string) => {
    publishCalls.push({ originClientId });
  },
  getOriginClientId: () => undefined,
}));

import { reconcileAppPins } from "../../../apps/app-pin-reconciler.js";
import { listAppPins, updateAppPin } from "../../../apps/app-pin-store.js";
import {
  createApp,
  deleteApp,
  isPluginAppId,
} from "../../../apps/app-store.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { appPins } from "../../../persistence/schema/index.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { ROUTES as APP_ROUTES } from "../app-management-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = APP_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const listHandler = findHandler("apps_list");
const pinHandler = findHandler("apps_pin");
const deleteHandler = findHandler("apps_delete");

await initializeDb();

interface ListedApp {
  id: string;
  name: string;
  pinSortPosition?: number;
  pinColor?: string;
}

/**
 * Install a plugin that bundles one app, and return the id the daemon builds
 * for it. A real directory rather than a hand-written id: `handlePinApp`
 * validates against `listPluginApps()`, so a synthetic id would be rejected and
 * this would stop covering plugin pinning at all.
 */
function installPluginApp(pluginName: string, appDir: string): string {
  const pluginRoot = join(getWorkspacePluginsDir(), pluginName);
  mkdirSync(join(pluginRoot, "apps", appDir), { recursive: true });
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0" }),
  );
  const id = `plugins~${pluginName}~${appDir}`;
  /* Guards the fixture, not the route: an id the daemon does not read as a
     plugin app would exercise the ordinary workspace path instead. */
  expect(isPluginAppId(id)).toBe(true);
  return id;
}

/** Retire a plugin the way an uninstall does: its apps stop enumerating. */
function uninstallPlugin(pluginName: string): void {
  rmSync(join(getWorkspacePluginsDir(), pluginName), {
    recursive: true,
    force: true,
  });
}

function makeApp(name: string): string {
  const app = createApp({
    name,
    schemaJson: "{}",
    htmlDefinition: "<html></html>",
  });
  return app.id;
}

async function listApps(): Promise<ListedApp[]> {
  const result = (await listHandler({} as RouteHandlerArgs)) as {
    apps: ListedApp[];
  };
  return result.apps;
}

async function pin(
  appId: string,
  body: { pinned?: boolean; color?: string | null },
) {
  return (await pinHandler({
    pathParams: { id: appId },
    body,
  } as unknown as RouteHandlerArgs)) as {
    success: boolean;
    appId: string;
    pinSortPosition: number | null;
    pinColor: string | null;
  };
}

async function findListed(appId: string): Promise<ListedApp | undefined> {
  return (await listApps()).find((app) => app.id === appId);
}

beforeEach(() => {
  publishCalls.length = 0;
  getDb().delete(appPins).run();
});

describe("apps_list", () => {
  /* Absent rather than null or 0: the client tells a pinned app from an
     unpinned one by whether the field is there at all. */
  test("omits the pin fields on an app that is not pinned", async () => {
    const appId = makeApp("Unpinned");

    const listed = await findListed(appId);

    expect(listed?.pinSortPosition).toBeUndefined();
    expect(listed?.pinColor).toBeUndefined();
  });

  test("carries the pin and its colour once one is set", async () => {
    const appId = makeApp("Pinned");
    await pin(appId, { pinned: true });
    await pin(appId, { color: "teal" });

    const listed = await findListed(appId);

    expect(listed?.pinSortPosition).toBeGreaterThan(0);
    expect(listed?.pinColor).toBe("teal");
  });

  test("orders pinned apps by when they were pinned", async () => {
    const first = makeApp("First");
    const second = makeApp("Second");
    await pin(first, { pinned: true });
    await pin(second, { pinned: true });

    const apps = await listApps();
    const firstPosition = apps.find((app) => app.id === first)?.pinSortPosition;
    const secondPosition = apps.find(
      (app) => app.id === second,
    )?.pinSortPosition;

    expect(firstPosition).toBeDefined();
    expect(secondPosition).toBeGreaterThan(firstPosition!);
  });

  /* The store can hold a pin for an id no app has, but such a pin has nothing
     to render, so it must never reach a client. Asserted through the route
     because the join is the only thing standing between the two. */
  test("a pin whose app is gone reaches no client", async () => {
    const appId = makeApp("Doomed");
    await pin(appId, { pinned: true });
    deleteApp(appId);

    const apps = await listApps();

    expect(apps.some((app) => app.id === appId)).toBe(false);
    expect(apps.some((app) => app.pinSortPosition !== undefined)).toBe(false);
  });
});

describe("apps_pin", () => {
  test("reports the resulting pin, and nulls once unpinned", async () => {
    const appId = makeApp("Togglable");

    expect(await pin(appId, { pinned: true })).toMatchObject({
      success: true,
      appId,
      pinColor: null,
    });
    expect(await pin(appId, { pinned: false })).toMatchObject({
      pinSortPosition: null,
      pinColor: null,
    });
  });

  /* Pin state is a preference about an app, not part of its content, so the
     plugin-app mutation guard does not apply. Driven through the route because
     that guard is what the route would otherwise impose. */
  test("pins a plugin app, whose record the daemon cannot write", async () => {
    const pluginAppId = installPluginApp("demo", "widget");

    const result = await pin(pluginAppId, { pinned: true });

    expect(result.pinSortPosition).not.toBeNull();
    expect(listAppPins()[0]?.appId).toBe(pluginAppId);
  });

  /* The list starts from the apps that exist, so a pin for anything else could
     never be read back and would sit in the table forever. */
  test("refuses to pin an app that does not exist", async () => {
    await expect(pin("no-such-app", { pinned: true })).rejects.toThrow(
      /App not found/,
    );
    expect(listAppPins()).toEqual([]);
  });

  /* Exempt from the check above: this is how a client clears a pin left over
     from an app that has since gone. */
  test("still accepts an unpin for an app that does not exist", async () => {
    expect(await pin("no-such-app", { pinned: false })).toMatchObject({
      pinSortPosition: null,
    });
  });

  test("rejects a request that asks for no change", async () => {
    const appId = makeApp("Untouched");

    await expect(pin(appId, {})).rejects.toThrow(/pinned or color is required/);
  });

  /*
   * `RouteDefinition.requestBody` is a codegen signal and does not validate, so
   * the handler is the only thing standing between a caller and the store. Both
   * transports reach this handler with whatever JSON arrived, so a cast here
   * would narrow nothing and a malformed value would land in the database and
   * come back out in the response.
   */
  describe("malformed bodies", () => {
    const cases: [string, unknown][] = [
      ["a non-boolean pinned", { pinned: "yes" }],
      ["a numeric pinned", { pinned: 1 }],
      ["a non-string colour", { pinned: true, color: 7 }],
      ["an array colour", { pinned: true, color: ["teal"] }],
      ["a body that is not an object", "pinned"],
    ];

    for (const [label, body] of cases) {
      test(`rejects ${label}`, async () => {
        const appId = makeApp(`App for ${label}`);

        await expect(
          pin(appId, body as { pinned?: boolean; color?: string | null }),
        ).rejects.toBeInstanceOf(BadRequestError);
        expect(listAppPins()).toEqual([]);
      });
    }
  });

  /* Other windows and devices learn about a pin only through this broadcast:
     nothing else tells them the app list changed. */
  test("announces the app list changed", async () => {
    const appId = makeApp("Broadcasting");

    await pin(appId, { pinned: true });

    expect(publishCalls).toHaveLength(1);
  });
});

/*
 * A workspace app's id is a UUID, so a pin left behind when one is deleted can
 * never be adopted. A plugin app's id is a path identity, so retiring a plugin
 * and installing it again rebuilds the same id: a pin left behind comes back
 * with it, for an app the user could not see to unpin while it was hidden.
 *
 * The reconcile runs on plugin-set convergence, at startup, and on a backstop
 * sweep, so these drive it directly. Nothing else happens between the retire
 * and the reinstall: an intervening pin write would be a trigger the real
 * sequence does not have, and the case would pass without proving anything.
 */
describe("orphan pins across a plugin reinstall", () => {
  test("a retired plugin's pin does not return when it is installed again", async () => {
    const pluginAppId = installPluginApp("demo", "widget");
    await pin(pluginAppId, { pinned: true });

    uninstallPlugin("demo");
    reconcileAppPins();
    installPluginApp("demo", "widget");

    const listed = await findListed(pluginAppId);
    expect(listed).toBeDefined();
    expect(listed?.pinSortPosition).toBeUndefined();
    expect(listAppPins()).toEqual([]);
  });

  /* The sensitivity check on the case above: without the reconcile between
     retire and reinstall the pin does come back, so that assertion is carried
     by the reconcile and not by the fixture happening to lose the row. */
  test("without the reconcile, the same sequence restores the pin", async () => {
    const pluginAppId = installPluginApp("demo", "widget");
    await pin(pluginAppId, { pinned: true });

    uninstallPlugin("demo");
    installPluginApp("demo", "widget");

    expect((await findListed(pluginAppId))?.pinSortPosition).toBeDefined();
  });

  test("leaves the pin alone while the plugin is still installed", async () => {
    const pluginAppId = installPluginApp("demo", "widget");
    await pin(pluginAppId, { pinned: true });

    reconcileAppPins();

    expect(listAppPins().map((entry) => entry.appId)).toEqual([pluginAppId]);
  });

  test("drops a pin for a workspace app that was deleted outside the route", () => {
    const appId = makeApp("Gone");
    updateAppPin(appId, { pinned: true });
    deleteApp(appId);

    reconcileAppPins();

    expect(listAppPins()).toEqual([]);
  });

  /* A pass is the one pin write with no request behind it, so nothing else
     tells a connected client. Without this the daemon converges and an open
     sidebar keeps rendering the pin until an unrelated app refetch lands. */
  test("announces the apps list when a pass removes a pin", () => {
    const appId = makeApp("Gone");
    updateAppPin(appId, { pinned: true });
    deleteApp(appId);
    publishCalls.length = 0;

    reconcileAppPins();

    expect(publishCalls).toHaveLength(1);
  });

  /* Counted rather than merely observed: a pass that announced unconditionally
     would drain every client's app list on a timer, sixty seconds apart,
     forever. */
  test("announces nothing when a pass removes no pin", () => {
    const appId = makeApp("Still here");
    updateAppPin(appId, { pinned: true });
    publishCalls.length = 0;

    reconcileAppPins();

    expect(publishCalls).toEqual([]);
  });
});

describe("apps_delete", () => {
  test("takes the deleted app's pin with it", async () => {
    const appId = makeApp("Deleted");
    await pin(appId, { pinned: true });

    await deleteHandler({
      pathParams: { id: appId },
    } as unknown as RouteHandlerArgs);

    expect(listAppPins()).toEqual([]);
  });

  test("leaves the other pins alone", async () => {
    const first = makeApp("First");
    const second = makeApp("Second");
    await pin(first, { pinned: true });
    await pin(second, { pinned: true });
    const survivorPosition = listAppPins().find(
      (entry) => entry.appId === second,
    )?.sortPosition;

    await deleteHandler({
      pathParams: { id: first },
    } as unknown as RouteHandlerArgs);

    expect(listAppPins().map((entry) => entry.appId)).toEqual([second]);
    expect(listAppPins()[0]?.sortPosition).toBe(survivorPosition!);
  });
});
