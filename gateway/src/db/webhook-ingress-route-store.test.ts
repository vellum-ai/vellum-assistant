/**
 * The registry decides which webhook paths this assistant answers at all, so
 * what it stores has to survive a byte-for-byte comparison later: nothing that
 * a URL parser would rewrite, nothing that escapes the webhook namespace, and
 * no second opinion about a path already claimed.
 */

import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import "../__tests__/test-preload.js";
import { pluginWebhookPath } from "../channels/plugin-ingress.js";
import { MAX_WEBHOOK_INGRESS_PATH_LENGTH } from "../velay/path-utils.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "./connection.js";
import { webhookIngressRoutes } from "./schema.js";
import {
  hasWebhookIngressRoute,
  listWebhookIngressRoutes,
  onWebhookIngressRoutesChanged,
  PLUGIN_WEBHOOK_ROUTE_TYPE,
  reconcilePluginWebhookIngressRoutes,
  registerWebhookIngressRoute,
  unregisterWebhookIngressRoute,
} from "./webhook-ingress-route-store.js";

const PATH = "/webhooks/telegram";

/** Write a row straight to the table, past what the register function accepts. */
function persistRow(path: string, type: string, source: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(webhookIngressRoutes)
    .values({
      path,
      type,
      source,
      match: "exact",
      createdAt: now,
      lastRegisteredAt: now,
    })
    .run();
}

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(webhookIngressRoutes).run();
});

describe("registerWebhookIngressRoute", () => {
  it("round-trips a route through the database", () => {
    registerWebhookIngressRoute({
      path: PATH,
      type: "telegram",
      source: "bot-1",
    });

    expect(listWebhookIngressRoutes()).toEqual([
      {
        path: PATH,
        type: "telegram",
        source: "bot-1",
        match: "exact",
        createdAt: expect.any(Number),
        lastRegisteredAt: expect.any(Number),
      },
    ]);
  });

  it("defaults an unattributed route's source to null", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });

    expect(listWebhookIngressRoutes()[0]?.source).toBeNull();
  });

  it("keeps one row per path however often it is registered", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });

    expect(listWebhookIngressRoutes()).toHaveLength(1);
  });

  it("refreshes the registration time and preserves the creation time", () => {
    const created = registerWebhookIngressRoute({
      path: PATH,
      type: "telegram",
    });
    // Age the row so the refresh is visible regardless of clock resolution.
    getGatewayDb()
      .update(webhookIngressRoutes)
      .set({ lastRegisteredAt: created.lastRegisteredAt - 60_000 })
      .where(eq(webhookIngressRoutes.path, PATH))
      .run();

    registerWebhookIngressRoute({ path: PATH, type: "telegram" });

    const [row] = listWebhookIngressRoutes();
    expect(row?.createdAt).toBe(created.createdAt);
    expect(row?.lastRegisteredAt).toBeGreaterThan(created.createdAt - 60_000);
  });

  it("lets a re-registration move the route's owner", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram", source: "a" });
    registerWebhookIngressRoute({ path: PATH, type: "telegram", source: "b" });

    expect(listWebhookIngressRoutes()[0]?.source).toBe("b");
  });

  it("accepts paths whose segments are opaque strings", () => {
    // The registry never interprets what is after `/webhooks/`; a plugin id
    // carrying dots or dashes is a name, not a traversal.
    for (const path of [
      "/webhooks/plugins/a.b/hook",
      "/webhooks/plugins/foo..bar/hook",
      "/webhooks/twilio/sms-inbound",
      `/webhooks/${"x".repeat(500)}`,
    ]) {
      expect(() =>
        registerWebhookIngressRoute({ path, type: "twilio" }),
      ).not.toThrow();
      expect(hasWebhookIngressRoute(path)).toBe(true);
    }
  });

  it("refuses anything outside the webhook namespace", () => {
    for (const path of [
      "/v1/audio/stream",
      "/hooks/telegram",
      "webhooks/telegram",
      "//webhooks/telegram",
      "/webhooks",
      "",
      "https://evil.example/webhooks/telegram",
    ]) {
      expect(() =>
        registerWebhookIngressRoute({ path, type: "telegram" }),
      ).toThrow();
    }
  });

  it("refuses paths that would not survive a byte-for-byte comparison", () => {
    for (const path of [
      "/webhooks/../admin",
      "/webhooks/../v1/guardian/init",
      "/webhooks/a/../../etc",
      "/webhooks/..%2fadmin",
      "/webhooks/%2e%2e/admin",
      "/webhooks/telegram?token=x",
      "/webhooks/telegram#frag",
      "/webhooks/telegram\\..\\etc",
      "/webhooks/foo%5c..%5cadmin",
      "/webhooks/foo%5Cbar",
      "/webhooks/tele gram",
      "/webhooks/telegram\n",
      "/webhooks/tele\tgram",
      `/webhooks/${"x".repeat(600)}`,
    ]) {
      expect(() =>
        registerWebhookIngressRoute({ path, type: "telegram" }),
      ).toThrow();
    }
    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("refuses the type the plugin reconcile owns", () => {
    // A row of this type is the reconcile's to keep or remove, so a claim
    // accepted here would be reaped the moment no plugin declares its path.
    expect(() =>
      registerWebhookIngressRoute({
        path: PATH,
        type: PLUGIN_WEBHOOK_ROUTE_TYPE,
        source: "meeting-bot",
      }),
    ).toThrow(/reserved/);
    expect(listWebhookIngressRoutes()).toEqual([]);
  });
});

describe("unregisterWebhookIngressRoute", () => {
  it("removes the route and reports that it existed", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });

    expect(unregisterWebhookIngressRoute(PATH)).toBe(true);
    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("reports a path it never held", () => {
    expect(unregisterWebhookIngressRoute(PATH)).toBe(false);
  });
});

describe("reconcilePluginWebhookIngressRoutes", () => {
  const REALTIME = "/webhooks/plugins/meeting-bot/realtime";
  const EVENTS = "/webhooks/plugins/meeting-bot/events";
  const NOTES = "/webhooks/plugins/notes/events";

  const claim = (path: string, source: string) => ({ path, source });

  function paths(): string[] {
    return listWebhookIngressRoutes()
      .map((r) => r.path)
      .sort();
  }

  it("leaves a row of another type at a desired path with its owner", () => {
    // The daemon claims plugin webhook paths under its own per-route types.
    // Such a row already admits the path, so the reconcile neither rewrites
    // its ownership nor removes it when the path leaves the servable set.
    registerWebhookIngressRoute({
      path: REALTIME,
      type: "plugin_meeting-bot_realtime_ab12cd34",
      source: "meeting-bot",
    });

    const first = reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
    ]);
    expect(first.added).toEqual([]);
    expect(first.removed).toEqual([]);

    const second = reconcilePluginWebhookIngressRoutes([]);
    expect(second.removed).toEqual([]);
    expect(listWebhookIngressRoutes().map((r) => [r.path, r.type])).toEqual([
      [REALTIME, "plugin_meeting-bot_realtime_ab12cd34"],
    ]);
  });

  it("claims every path in the set, attributed to its plugin", () => {
    // The empty-registry case is the one that matters: a persisted grant holds
    // no row of its own, so a reconcile is what populates the registry from it.
    const { added, removed } = reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
      claim(NOTES, "notes"),
    ]);

    expect(added.sort()).toEqual([REALTIME, NOTES].sort());
    expect(removed).toEqual([]);
    expect(
      listWebhookIngressRoutes()
        .map((r) => [r.path, r.type, r.source])
        .sort(),
    ).toEqual([
      [REALTIME, "plugin", "meeting-bot"],
      [NOTES, "plugin", "notes"],
    ]);
  });

  it("drops a plugin path that is no longer servable and keeps the rest", () => {
    reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
      claim(EVENTS, "meeting-bot"),
    ]);

    // What a partial revocation looks like from here: the source still holds
    // one path, so the row for the other has to go and this one has to stay.
    const { added, removed } = reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
    ]);

    expect(added).toEqual([]);
    expect(removed).toEqual([EVENTS]);
    expect(paths()).toEqual([REALTIME]);
  });

  it("drops every plugin path when nothing is servable", () => {
    reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
      claim(NOTES, "notes"),
    ]);

    expect(reconcilePluginWebhookIngressRoutes([]).removed.sort()).toEqual(
      [NOTES, REALTIME].sort(),
    );
    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("leaves rows another subsystem registered alone", () => {
    // Same source name, different type. A plugin reconcile has no say over a
    // claim it did not make.
    registerWebhookIngressRoute({
      path: PATH,
      type: "telegram",
      source: "meeting-bot",
    });

    reconcilePluginWebhookIngressRoutes([]);

    expect(listWebhookIngressRoutes().map((r) => r.type)).toEqual(["telegram"]);
  });

  it("keeps the original claim time when a path stays servable", () => {
    reconcilePluginWebhookIngressRoutes([claim(REALTIME, "meeting-bot")]);
    const createdAt = listWebhookIngressRoutes()[0]?.createdAt;

    reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
      claim(NOTES, "notes"),
    ]);

    expect(
      listWebhookIngressRoutes().find((r) => r.path === REALTIME)?.createdAt,
    ).toBe(createdAt);
  });

  it("fires the change listener once for the whole reconcile", () => {
    reconcilePluginWebhookIngressRoutes([claim(EVENTS, "meeting-bot")]);

    let fired = 0;
    const unsubscribe = onWebhookIngressRoutesChanged(() => {
      fired += 1;
    });

    // One addition and one removal in the same pass: subscribers re-advertise
    // the whole path set, so they only ever need telling once.
    reconcilePluginWebhookIngressRoutes([claim(REALTIME, "meeting-bot")]);
    expect(fired).toBe(1);

    unsubscribe();
  });

  it("stays quiet when the registry already matches", () => {
    reconcilePluginWebhookIngressRoutes([claim(REALTIME, "meeting-bot")]);

    let fired = 0;
    const unsubscribe = onWebhookIngressRoutesChanged(() => {
      fired += 1;
    });

    const { added, removed } = reconcilePluginWebhookIngressRoutes([
      claim(REALTIME, "meeting-bot"),
    ]);

    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(fired).toBe(0);

    unsubscribe();
  });

  it("stores both spellings of a composition at the registry's bound", () => {
    // The budget is shared between the plugin name and the declared path, so
    // whichever half spends it, a composition discovery accepted registers.
    for (const [plugin, route] of [
      ["p".repeat(255), "x".repeat(237)],
      ["p", "x".repeat(491)],
    ] as const) {
      const path = pluginWebhookPath(plugin, route);
      expect(`${path}/`).toHaveLength(MAX_WEBHOOK_INGRESS_PATH_LENGTH);

      const { added, rejected } = reconcilePluginWebhookIngressRoutes([
        claim(path, plugin),
        claim(`${path}/`, plugin),
      ]);

      expect(rejected).toEqual([]);
      expect(added.sort()).toEqual([path, `${path}/`].sort());
    }
  });

  it("leaves a plugin-typed row outside the plugin namespace alone", () => {
    // A row the public IPC persisted under this type sits outside the
    // namespace the reconcile owns, so it is not the reconcile's to reap.
    persistRow("/webhooks/plugin", PLUGIN_WEBHOOK_ROUTE_TYPE, "acme");
    reconcilePluginWebhookIngressRoutes([claim(REALTIME, "meeting-bot")]);

    const { removed } = reconcilePluginWebhookIngressRoutes([]);

    // The namespace row still follows what plugins declare; the other stays.
    expect(removed).toEqual([REALTIME]);
    expect(paths()).toEqual(["/webhooks/plugin"]);
  });

  it("refuses to claim a path outside the plugin namespace", () => {
    // The reconcile writes only rows it can also withdraw, so a claim it would
    // never reap is reported instead of stored.
    const outside = "/webhooks/telegram";

    const { added, rejected } = reconcilePluginWebhookIngressRoutes([
      claim(outside, "meeting-bot"),
      claim(NOTES, "notes"),
    ]);

    expect(rejected).toEqual([outside]);
    expect(added).toEqual([NOTES]);
    expect(paths()).toEqual([NOTES]);
  });

  it("skips a path it could not compare byte for byte and settles the rest", () => {
    // One plugin declaring something unstorable must not stop every other
    // plugin's paths from settling, so it is reported rather than thrown.
    const bad = "/webhooks/plugins/meeting-bot/../../admin";

    const { added, rejected } = reconcilePluginWebhookIngressRoutes([
      claim(bad, "meeting-bot"),
      claim(NOTES, "notes"),
    ]);

    expect(rejected).toEqual([bad]);
    expect(added).toEqual([NOTES]);
    expect(paths()).toEqual([NOTES]);
  });
});

describe("hasWebhookIngressRoute", () => {
  it("answers only for the exact path", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });

    expect(hasWebhookIngressRoute(PATH)).toBe(true);
    expect(hasWebhookIngressRoute("/webhooks/telegram/extra")).toBe(false);
    expect(hasWebhookIngressRoute("/webhooks/teleg")).toBe(false);
    expect(hasWebhookIngressRoute("/webhooks/twilio")).toBe(false);
  });
});

describe("onWebhookIngressRoutesChanged", () => {
  it("fires when the set of routes changes", () => {
    let fired = 0;
    const unsubscribe = onWebhookIngressRoutesChanged(() => {
      fired += 1;
    });

    registerWebhookIngressRoute({ path: PATH, type: "telegram" });
    expect(fired).toBe(1);

    unregisterWebhookIngressRoute(PATH);
    expect(fired).toBe(2);

    unsubscribe();
  });

  it("stays quiet when a re-registration changes nothing", () => {
    registerWebhookIngressRoute({ path: PATH, type: "telegram", source: "a" });

    let fired = 0;
    const unsubscribe = onWebhookIngressRoutesChanged(() => {
      fired += 1;
    });

    registerWebhookIngressRoute({ path: PATH, type: "telegram", source: "a" });
    expect(fired).toBe(0);

    registerWebhookIngressRoute({ path: PATH, type: "telegram", source: "b" });
    expect(fired).toBe(1);

    unsubscribe();
  });

  it("stays quiet when a removal finds nothing and after unsubscribing", () => {
    let fired = 0;
    const unsubscribe = onWebhookIngressRoutesChanged(() => {
      fired += 1;
    });

    unregisterWebhookIngressRoute(PATH);
    expect(fired).toBe(0);

    unsubscribe();
    registerWebhookIngressRoute({ path: PATH, type: "telegram" });
    expect(fired).toBe(0);
  });
});
