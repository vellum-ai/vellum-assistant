/**
 * The registry is what decides whether an inbound webhook is answered, so the
 * IPC surface has to refuse a claim while the flag is off, refuse a path the
 * store would not store, and otherwise show back exactly what it wrote.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

import "../__tests__/test-preload.js";

let flagEnabled = true;

mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (_key: string) => flagEnabled,
}));

import {
  ListWebhookRoutesIpcResponseSchema,
  RegisterWebhookRouteIpcResponseSchema,
  UnregisterWebhookRouteIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { webhookIngressRoutes } from "../db/schema.js";
import { watchPluginIngressForWebhookRoutes } from "../channels/plugin-webhook-route-sync.js";
import { createWebhookRouteRoutes } from "./webhook-route-handlers.js";

const PATH = "/webhooks/telegram";

const routes = createWebhookRouteRoutes();

function route(method: string) {
  const found = routes.find((r) => r.method === method);
  if (!found) throw new Error(`No route registered for ${method}`);
  return found;
}

const register = (params: Record<string, unknown>) =>
  route("register_webhook_route").handler(params);
const unregister = (params: Record<string, unknown>) =>
  route("unregister_webhook_route").handler(params);
const list = () => route("list_webhook_routes").handler();

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  flagEnabled = true;
  getGatewayDb().delete(webhookIngressRoutes).run();
});

describe("register_webhook_route", () => {
  it("rejects params the store could never key on", () => {
    const schema = route("register_webhook_route").schema;

    expect(schema?.safeParse({ path: PATH, type: "telegram" }).success).toBe(
      true,
    );
    expect(schema?.safeParse({ path: "", type: "telegram" }).success).toBe(
      false,
    );
    expect(schema?.safeParse({ path: PATH, type: "" }).success).toBe(false);
    expect(schema?.safeParse({ path: PATH }).success).toBe(false);
  });

  it("refuses without writing while the flag is off", () => {
    flagEnabled = false;

    expect(register({ path: PATH, type: "telegram" })).toEqual({
      disabled: true,
    });
    expect(list()).toEqual({ routes: [] });
  });

  it("returns the stored row and shows it in the listing", () => {
    const result = register({
      path: PATH,
      type: "telegram",
      source: "bot-1",
    }) as { disabled: false; route: unknown };

    expect(result).toEqual({
      disabled: false,
      route: {
        path: PATH,
        type: "telegram",
        source: "bot-1",
        match: "exact",
        createdAt: expect.any(Number),
        lastRegisteredAt: expect.any(Number),
      },
    });
    expect(list()).toEqual({ routes: [result.route] });
  });

  it("stores an unattributed route with a null source", () => {
    register({ path: PATH, type: "telegram" });

    expect(list()).toEqual({
      routes: [expect.objectContaining({ source: null })],
    });
  });

  it("refuses the type the plugin reconcile owns, with a client error", () => {
    // Rows of that type are the reconcile's to keep or remove, so a caller
    // claiming one would lose it the moment no plugin declares its path.
    let thrown: unknown;
    try {
      register({ path: PATH, type: "plugin", source: "meeting-bot" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      statusCode: 400,
      code: "reserved_webhook_route_type",
    });
    expect(list()).toEqual({ routes: [] });
  });

  it("throws on a path outside the webhook namespace", () => {
    expect(() => register({ path: "/v1/admin", type: "telegram" })).toThrow();
    expect(() =>
      register({ path: "/webhooks/../admin", type: "telegram" }),
    ).toThrow();
    expect(list()).toEqual({ routes: [] });
  });
});

describe("shared IPC contract", () => {
  it("answers every method in the shape the daemon parses", () => {
    flagEnabled = false;
    expect(
      RegisterWebhookRouteIpcResponseSchema.safeParse(
        register({ path: PATH, type: "telegram" }),
      ).success,
    ).toBe(true);

    flagEnabled = true;
    expect(
      RegisterWebhookRouteIpcResponseSchema.safeParse(
        register({ path: PATH, type: "telegram", source: "bot-1" }),
      ).success,
    ).toBe(true);
    expect(ListWebhookRoutesIpcResponseSchema.safeParse(list()).success).toBe(
      true,
    );
    expect(
      UnregisterWebhookRouteIpcResponseSchema.safeParse(
        unregister({ path: PATH }),
      ).success,
    ).toBe(true);
  });
});

describe("unregister_webhook_route", () => {
  it("removes a registered route and reports it", () => {
    register({ path: PATH, type: "telegram" });

    expect(unregister({ path: PATH })).toEqual({ removed: true });
    expect(list()).toEqual({ routes: [] });
  });

  it("reports a path it never held", () => {
    expect(unregister({ path: PATH })).toEqual({ removed: false });
  });

  it("asks the reconcile to reclaim a removed plugin-namespace path", async () => {
    // A daemon-claimed row can be the only entry admitting a servable plugin
    // route, so its removal arms the poll to settle the namespace again. The
    // poll only runs a settle while armed, so settle invocations are the
    // observable. A non-namespace removal is the control: it must arm nothing.
    const emptyResolution = {
      approved: [],
      pending: [],
      problems: [],
    } as never;
    const pollSettles = async (): Promise<number> => {
      let settles = 0;
      const unwatch = watchPluginIngressForWebhookRoutes({
        subscribe: () => () => {},
        resolve: () => {
          settles += 1;
          return emptyResolution;
        },
        refresh: () => {},
        pollIntervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 30));
      unwatch();
      return settles;
    };

    register({ path: PATH, type: "telegram" });
    expect(unregister({ path: PATH })).toEqual({ removed: true });
    expect(await pollSettles()).toBe(0);

    const claimed = "/webhooks/plugins/meeting-bot/realtime";
    register({ path: claimed, type: "plugin_meeting-bot_realtime_ab12cd34" });
    expect(unregister({ path: claimed })).toEqual({ removed: true });
    expect(await pollSettles()).toBeGreaterThan(0);
  });

  it("still revokes and lists while the flag is off", () => {
    register({ path: PATH, type: "telegram" });
    flagEnabled = false;

    expect(list()).toEqual({
      routes: [expect.objectContaining({ path: PATH })],
    });
    expect(unregister({ path: PATH })).toEqual({ removed: true });
    expect(list()).toEqual({ routes: [] });
  });
});
