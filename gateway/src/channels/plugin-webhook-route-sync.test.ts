import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../__tests__/test-preload.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { pluginIngressApprovals, webhookIngressRoutes } from "../db/schema.js";
import { listWebhookIngressRoutes } from "../db/webhook-ingress-route-store.js";
import { resolvePluginIngress } from "./plugin-ingress-approvals.js";
import {
  PLUGIN_INGRESS_MANIFEST_RELPATH,
  PluginIngressCache,
} from "./plugin-ingress.js";
import {
  reconcilePluginWebhookRoutes,
  watchPluginIngressForWebhookRoutes,
} from "./plugin-webhook-route-sync.js";

const created: string[] = [];
let workspaceDir = "";

const VELLUM_ROUTE = {
  path: "platform",
  kind: "http" as const,
  signer: "vellum" as const,
  handshake: "signed-headers" as const,
  description: "platform callback",
};

function writePlugin(plugin: string, routes: unknown = [VELLUM_ROUTE]): void {
  const pluginDir = join(workspaceDir, "plugins", plugin);
  mkdirSync(join(pluginDir, "channels"), { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: plugin }),
  );
  writeFileSync(
    join(pluginDir, PLUGIN_INGRESS_MANIFEST_RELPATH),
    JSON.stringify({ routes }),
  );
}

/** Let the deferred reconcile run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(pluginIngressApprovals).run();
  getGatewayDb().delete(webhookIngressRoutes).run();

  workspaceDir = mkdtempSync(join(tmpdir(), "plugin-route-sync-"));
  created.push(workspaceDir);
});

afterEach(() => {
  resetGatewayDb();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("watchPluginIngressForWebhookRoutes", () => {
  function watch(cache: PluginIngressCache): () => void {
    return watchPluginIngressForWebhookRoutes({
      subscribe: (cb) => cache.onChange(cb),
      resolve: () => resolvePluginIngress({ workspaceDir }),
      // Every case but the polling one drives the refresh itself.
      refresh: () => {},
      pollIntervalMs: 60_000,
    });
  }

  it("claims a route a plugin installed while the gateway runs", async () => {
    // A `signer: "vellum"` route is served without a guardian decision, so no
    // approval or revocation is coming to settle the registry for it.
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    const unwatch = watch(cache);
    cache.get();
    await settle();
    expect(listWebhookIngressRoutes()).toEqual([]);

    writePlugin("meeting-bot");
    cache.get();
    await settle();

    expect(
      listWebhookIngressRoutes()
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      "/webhooks/plugins/meeting-bot/platform",
      "/webhooks/plugins/meeting-bot/platform/",
    ]);
    unwatch();
  });

  it("releases the routes of a plugin uninstalled while the gateway runs", async () => {
    writePlugin("meeting-bot");
    reconcilePluginWebhookRoutes(() => resolvePluginIngress({ workspaceDir }));
    expect(listWebhookIngressRoutes()).toHaveLength(2);

    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    const unwatch = watch(cache);
    cache.get();
    rmSync(join(workspaceDir, "plugins", "meeting-bot"), {
      recursive: true,
      force: true,
    });
    cache.get();
    await settle();

    expect(listWebhookIngressRoutes()).toEqual([]);
    unwatch();
  });

  it("re-reads discovery on a timer, since an unclaimed route draws no request", async () => {
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    const unwatch = watchPluginIngressForWebhookRoutes({
      subscribe: (cb) => cache.onChange(cb),
      resolve: () => resolvePluginIngress({ workspaceDir }),
      refresh: () => {
        cache.get();
      },
      pollIntervalMs: 5,
    });

    writePlugin("meeting-bot");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(listWebhookIngressRoutes()).toHaveLength(2);
    unwatch();
  });

  it("settles a burst of changes once", async () => {
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    let reconciles = 0;
    const unwatch = watchPluginIngressForWebhookRoutes({
      subscribe: (cb) => cache.onChange(cb),
      resolve: () => {
        reconciles += 1;
        return resolvePluginIngress({ workspaceDir });
      },
      refresh: () => {},
      pollIntervalMs: 60_000,
    });

    writePlugin("meeting-bot");
    cache.get();
    writePlugin("notes");
    cache.get();
    await settle();

    expect(reconciles).toBe(1);
    expect(listWebhookIngressRoutes()).toHaveLength(4);
    unwatch();
  });

  it("retries a failed settle on the next poll tick", async () => {
    // The cache commits its fingerprint before the settle runs, so without a
    // retained retry a reconcile that failed once would stay stale until the
    // next declaration change or restart.
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    let fail = true;
    const unwatch = watchPluginIngressForWebhookRoutes({
      subscribe: (cb) => cache.onChange(cb),
      resolve: () => {
        if (fail) {
          fail = false;
          throw new Error("transient");
        }
        return resolvePluginIngress({ workspaceDir });
      },
      refresh: () => {},
      pollIntervalMs: 10,
    });

    writePlugin("meeting-bot");
    cache.get();
    await settle();
    expect(listWebhookIngressRoutes()).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listWebhookIngressRoutes()).toHaveLength(2);
    unwatch();
  });

  it("retries a settle that failed outside the watcher", async () => {
    // An approval handler reconciles directly after persisting the grant. If
    // that settle fails, the poll owns the retry even though no declaration
    // change ever reaches the watcher.
    writePlugin("meeting-bot");
    let calls = 0;
    const resolve = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return resolvePluginIngress({ workspaceDir });
    };
    expect(reconcilePluginWebhookRoutes(resolve)).toBe(false);
    expect(listWebhookIngressRoutes()).toEqual([]);

    const unwatch = watchPluginIngressForWebhookRoutes({
      subscribe: () => () => {},
      resolve,
      refresh: () => {},
      pollIntervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(listWebhookIngressRoutes()).toHaveLength(2);
    unwatch();
  });

  it("stops reconciling once unsubscribed", async () => {
    const cache = new PluginIngressCache({ workspaceDir, ttlMs: 0 });
    watch(cache)();

    writePlugin("meeting-bot");
    cache.get();
    await settle();

    expect(listWebhookIngressRoutes()).toEqual([]);
  });
});
