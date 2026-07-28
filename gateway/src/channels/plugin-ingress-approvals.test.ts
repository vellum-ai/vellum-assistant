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
import {
  approvePluginIngress,
  revokePluginIngressApproval,
} from "../db/plugin-ingress-approval-store.js";
import { pluginIngressApprovals } from "../db/schema.js";
import { PLUGIN_INGRESS_MANIFEST_RELPATH } from "./plugin-ingress.js";
import {
  ingressDeclarationDigest,
  resolvePluginIngress,
} from "./plugin-ingress-approvals.js";

const created: string[] = [];

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(pluginIngressApprovals).run();
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

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-ingress-approvals-"));
  created.push(dir);
  return dir;
}

const ROUTES = [
  {
    path: "realtime",
    kind: "websocket" as const,
    signer: "plugin" as const,
    description: "events",
  },
];

function writePlugin(
  workspaceDir: string,
  plugin: string,
  routes: unknown = ROUTES,
): void {
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

describe("ingressDeclarationDigest", () => {
  it("is stable across route ordering", () => {
    const a = ingressDeclarationDigest([
      { kind: "http", signer: "plugin", path: "a" },
      { kind: "http", signer: "plugin", path: "b" },
    ]);
    const b = ingressDeclarationDigest([
      { kind: "http", signer: "plugin", path: "b" },
      { kind: "http", signer: "plugin", path: "a" },
    ]);
    expect(a).toBe(b);
  });

  it("ignores a description reword so an approval survives it", () => {
    const before = ingressDeclarationDigest([
      {
        kind: "http",
        signer: "plugin",
        path: "a",
        description: "one",
      } as never,
    ]);
    const after = ingressDeclarationDigest([
      {
        kind: "http",
        signer: "plugin",
        path: "a",
        description: "reworded",
      } as never,
    ]);
    expect(after).toBe(before);
  });

  it("changes when the signer changes", () => {
    // Switching signer changes whose key opens the route, so an approval for
    // one must not carry over to the other.
    expect(
      ingressDeclarationDigest([{ kind: "http", signer: "vellum", path: "a" }]),
    ).not.toBe(
      ingressDeclarationDigest([{ kind: "http", signer: "plugin", path: "a" }]),
    );
  });

  it("changes when reach widens or a transport changes", () => {
    const base = ingressDeclarationDigest([
      { kind: "http", signer: "plugin", path: "a" },
    ]);
    expect(
      ingressDeclarationDigest([
        { kind: "http", signer: "plugin", path: "a" },
        { kind: "http", signer: "plugin", path: "b" },
      ]),
    ).not.toBe(base);
    expect(
      ingressDeclarationDigest([
        { kind: "websocket", signer: "plugin", path: "a" },
      ]),
    ).not.toBe(base);
  });
});

describe("resolvePluginIngress", () => {
  it("holds an unapproved declaration as pending, never approved", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");

    const { approved, pending } = resolvePluginIngress({ workspaceDir });
    expect(approved).toEqual([]);
    expect(pending.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("approves a declaration matching its approval row", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    const { approved, pending } = resolvePluginIngress({ workspaceDir });
    expect(pending).toEqual([]);
    expect(approved.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("revokes an approval when the declaration changes", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    // Approving one declaration must not approve whatever replaces it.
    writePlugin(workspaceDir, "meeting-bot", [
      ...ROUTES,
      { path: "extra", kind: "http", description: "widened" },
    ]);

    const { approved, pending } = resolvePluginIngress({ workspaceDir });
    expect(approved).toEqual([]);
    expect(pending.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("does not let one plugin's approval cover another", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");
    writePlugin(workspaceDir, "other");
    // Identical routes, so an identical digest — only the approved plugin
    // is served.
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    const { approved, pending } = resolvePluginIngress({ workspaceDir });
    expect(approved.map((p) => p.plugin)).toEqual(["meeting-bot"]);
    expect(pending.map((p) => p.plugin)).toEqual(["other"]);
  });

  it("stops serving a plugin whose approval is revoked", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });
    expect(resolvePluginIngress({ workspaceDir }).approved).toHaveLength(1);

    revokePluginIngressApproval("meeting-bot");

    const { approved, pending } = resolvePluginIngress({ workspaceDir });
    expect(approved).toEqual([]);
    expect(pending.map((p) => p.plugin)).toEqual(["meeting-bot"]);
  });

  it("approves nothing when no approvals are recorded", () => {
    // Fail closed: an empty table serves no routes.
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "meeting-bot");
    writePlugin(workspaceDir, "other");

    expect(resolvePluginIngress({ workspaceDir }).approved).toEqual([]);
  });

  it("passes discovery problems through", () => {
    const workspaceDir = makeWorkspace();
    writePlugin(workspaceDir, "broken", [{ path: "/absolute", kind: "http" }]);

    const { approved, pending, problems } = resolvePluginIngress({
      workspaceDir,
    });
    expect(approved).toEqual([]);
    expect(pending).toEqual([]);
    expect(problems.map((p) => p.plugin)).toEqual(["broken"]);
  });
});
