/**
 * Tests for app pinning across the app-management routes.
 *
 * Covers the two things the client depends on that the pin store alone cannot
 * show: that a pin reaches the client on the app list rather than on a call of
 * its own, and that deleting an app takes its pin with it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const publishCalls: unknown[] = [];

mock.module("../../sync/resource-sync-events.js", () => ({
  publishAppsChanged: (originClientId?: string) => {
    publishCalls.push({ originClientId });
  },
  getOriginClientId: () => undefined,
}));

import { listAppPins } from "../../../apps/app-pin-store.js";
import {
  createApp,
  deleteApp,
  isPluginAppId,
} from "../../../apps/app-store.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { appPins } from "../../../persistence/schema/index.js";
import { ROUTES as APP_ROUTES } from "../app-management-routes.js";
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
    const pluginAppId = "plugins~demo~widget";
    /* Guards the fixture, not the route: an id the daemon does not read as a
       plugin app would exercise the ordinary workspace path and this case
       would pass without ever reaching the behaviour it names. */
    expect(isPluginAppId(pluginAppId)).toBe(true);

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

  /* Other windows and devices learn about a pin only through this broadcast:
     nothing else tells them the app list changed. */
  test("announces the app list changed", async () => {
    const appId = makeApp("Broadcasting");

    await pin(appId, { pinned: true });

    expect(publishCalls).toHaveLength(1);
  });
});

/*
 * `deleteApp` is filesystem-level and runs where no migrated database exists,
 * so it cannot clear a pin itself. Deletions that bypass the route (the
 * `app_delete` tool, a plugin uninstall, a directory removed by hand) therefore
 * leave a row behind, and the next pin write is what collects it.
 */
describe("orphan reconcile", () => {
  test("a pin write clears pins whose app is gone", async () => {
    const survivor = makeApp("Survivor");
    const doomed = makeApp("Doomed");
    await pin(survivor, { pinned: true });
    await pin(doomed, { pinned: true });

    deleteApp(doomed);
    expect(listAppPins().map((entry) => entry.appId)).toEqual([
      survivor,
      doomed,
    ]);

    await pin(survivor, { color: "teal" });

    expect(listAppPins().map((entry) => entry.appId)).toEqual([survivor]);
  });

  test("leaves pins whose app still exists", async () => {
    const first = makeApp("First");
    const second = makeApp("Second");
    await pin(first, { pinned: true });
    await pin(second, { pinned: true });

    await pin(first, { color: "teal" });

    expect(listAppPins().map((entry) => entry.appId)).toEqual([first, second]);
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
