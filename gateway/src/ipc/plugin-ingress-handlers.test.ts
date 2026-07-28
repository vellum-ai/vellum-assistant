import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../__tests__/test-preload.js";
import { ingressDeclarationDigest } from "../channels/plugin-ingress-approvals.js";
import { PLUGIN_INGRESS_MANIFEST_RELPATH } from "../channels/plugin-ingress.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { getPluginIngressApproval } from "../db/plugin-ingress-approval-store.js";
import { pluginIngressApprovals } from "../db/schema.js";
import { pluginIngressRoutes } from "./plugin-ingress-handlers.js";

const created: string[] = [];
let workspaceDir = "";
let previousWorkspaceEnv: string | undefined;

const ROUTES = [{ path: "realtime", kind: "websocket", description: "events" }];

function route(method: string) {
  const found = pluginIngressRoutes.find((r) => r.method === method);
  if (!found) {
    throw new Error(`no route ${method}`);
  }
  return found;
}

function writePlugin(plugin: string, routes: unknown = ROUTES): void {
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

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(pluginIngressApprovals).run();

  workspaceDir = mkdtempSync(join(tmpdir(), "plugin-ingress-ipc-"));
  created.push(workspaceDir);
  // The handlers resolve the workspace from the environment, so point it
  // at a scratch directory rather than the developer's real workspace.
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  resetGatewayDb();
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("plugin_ingress_list", () => {
  it("reports a declaration as unapproved with its absolute path", async () => {
    writePlugin("meeting-bot");

    const res = (await route("plugin_ingress_list").handler({})) as {
      declarations: {
        plugin: string;
        approved: boolean;
        routes: { publicPath: string }[];
      }[];
    };

    expect(res.declarations).toHaveLength(1);
    expect(res.declarations[0]!.approved).toBe(false);
    expect(res.declarations[0]!.routes[0]!.publicPath).toBe(
      "/webhooks/plugins/meeting-bot/realtime",
    );
  });

  it("surfaces declarations that failed validation", async () => {
    writePlugin("broken", [{ path: "/absolute", kind: "http" }]);

    const res = (await route("plugin_ingress_list").handler({})) as {
      declarations: unknown[];
      problems: { plugin: string }[];
    };

    expect(res.declarations).toEqual([]);
    expect(res.problems.map((p) => p.plugin)).toEqual(["broken"]);
  });
});

describe("plugin_ingress_approve", () => {
  it("records an approval and flips the declaration to approved", async () => {
    writePlugin("meeting-bot");
    const digest = ingressDeclarationDigest(
      ROUTES as { kind: "websocket"; path: string }[],
    );

    await route("plugin_ingress_approve").handler({
      plugin: "meeting-bot",
      digest,
    });

    expect(getPluginIngressApproval("meeting-bot")?.digest).toBe(digest);
    const res = (await route("plugin_ingress_list").handler({})) as {
      declarations: { approved: boolean }[];
    };
    expect(res.declarations[0]!.approved).toBe(true);
  });

  it("refuses a digest that is not what the plugin currently declares", () => {
    // Otherwise a caller could pre-approve routes nobody has seen, which
    // would activate the moment a manifest happened to match.
    writePlugin("meeting-bot");

    expect(() =>
      route("plugin_ingress_approve").handler({
        plugin: "meeting-bot",
        digest: "0".repeat(32),
      }),
    ).toThrow(/digest mismatch/);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("refuses a plugin that declares nothing", () => {
    expect(() =>
      route("plugin_ingress_approve").handler({
        plugin: "ghost",
        digest: "0".repeat(32),
      }),
    ).toThrow(/declares no ingress routes/);
  });

  it("refuses a declaration that failed validation", () => {
    writePlugin("broken", [{ path: "/absolute", kind: "http" }]);

    expect(() =>
      route("plugin_ingress_approve").handler({
        plugin: "broken",
        digest: "0".repeat(32),
      }),
    ).toThrow(/declares no ingress routes/);
  });

  it("rejects unknown params rather than ignoring them", () => {
    writePlugin("meeting-bot");
    expect(() =>
      route("plugin_ingress_approve").handler({
        plugin: "meeting-bot",
        digest: ingressDeclarationDigest(
          ROUTES as { kind: "websocket"; path: string }[],
        ),
        force: true,
      }),
    ).toThrow();
  });
});

describe("plugin_ingress_revoke", () => {
  it("removes an approval and reports that it did", async () => {
    writePlugin("meeting-bot");
    const digest = ingressDeclarationDigest(
      ROUTES as { kind: "websocket"; path: string }[],
    );
    await route("plugin_ingress_approve").handler({
      plugin: "meeting-bot",
      digest,
    });

    const res = (await route("plugin_ingress_revoke").handler({
      plugin: "meeting-bot",
    })) as { revoked: boolean };

    expect(res.revoked).toBe(true);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("reports when there was nothing to revoke", async () => {
    const res = (await route("plugin_ingress_revoke").handler({
      plugin: "meeting-bot",
    })) as { revoked: boolean };
    expect(res.revoked).toBe(false);
  });
});
