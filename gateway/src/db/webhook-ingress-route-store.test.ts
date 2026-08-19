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
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "./connection.js";
import { webhookIngressRoutes } from "./schema.js";
import {
  hasWebhookIngressRoute,
  listWebhookIngressRoutes,
  onWebhookIngressRoutesChanged,
  registerWebhookIngressRoute,
  unregisterWebhookIngressRoute,
} from "./webhook-ingress-route-store.js";

const PATH = "/webhooks/telegram";

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
      "/webhooks/twilio/sms-inbound",
      `/webhooks/${"x".repeat(500)}`,
    ]) {
      expect(() =>
        registerWebhookIngressRoute({ path, type: "plugin" }),
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
      "/webhooks/../v1/guardian/init",
      "/webhooks/a/../../etc",
      "/webhooks/telegram?token=x",
      "/webhooks/telegram#frag",
      "/webhooks/telegram\\..\\etc",
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
