import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import {
  ingressDeclarationDigest,
  resolvePluginIngress,
} from "../../channels/plugin-ingress-approvals.js";
import { PLUGIN_INGRESS_MANIFEST_RELPATH } from "../../channels/plugin-ingress.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import {
  approvePluginIngress,
  getPluginIngressApproval,
} from "../../db/plugin-ingress-approval-store.js";
import { pluginIngressApprovals } from "../../db/schema.js";
import {
  createChannelIngressApproveHandler,
  createChannelIngressRevokeHandler,
} from "./channel-ingress.js";

const created: string[] = [];
let workspaceDir = "";

const ROUTES = [
  {
    path: "realtime",
    kind: "websocket" as const,
    signer: "plugin" as const,
    handshake: "signed-headers" as const,
    description: "events",
  },
];

// Resolve against this test's scratch workspace rather than the ambient one.
// Another suite mocks `paths.js` process-wide, so reading the env here would
// make these assertions depend on test file ordering.
const approve = createChannelIngressApproveHandler(() =>
  resolvePluginIngress({ workspaceDir }),
);
const revoke = createChannelIngressRevokeHandler();

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

function approveRequest(body: unknown): Request {
  return new Request("http://gateway/v1/channel-ingress/meeting-bot/approve", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function revokeRequest(): Request {
  return new Request("http://gateway/v1/channel-ingress/meeting-bot/revoke", {
    method: "POST",
  });
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(pluginIngressApprovals).run();

  workspaceDir = mkdtempSync(join(tmpdir(), "channel-ingress-"));
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

describe("approve", () => {
  it("records an approval for the declaration the plugin currently makes", async () => {
    writePlugin("meeting-bot");
    const digest = ingressDeclarationDigest(ROUTES);

    const res = await approve(approveRequest({ digest }), "meeting-bot");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "meeting-bot",
      digest,
    });
    expect(getPluginIngressApproval("meeting-bot")?.digest).toBe(digest);
  });

  it("refuses a digest that is not what the plugin currently declares", async () => {
    // Otherwise a guardian could record a grant for routes nobody has seen,
    // which would activate the moment a manifest happened to match.
    writePlugin("meeting-bot");

    const res = await approve(
      approveRequest({ digest: "0".repeat(32) }),
      "meeting-bot",
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      declaredDigest: ingressDeclarationDigest(ROUTES),
    });
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("refuses a plugin that declares nothing", async () => {
    const res = await approve(
      approveRequest({ digest: "0".repeat(32) }),
      "ghost",
    );

    expect(res.status).toBe(404);
    expect(getPluginIngressApproval("ghost")).toBeUndefined();
  });

  it("refuses a declaration that failed validation", async () => {
    writePlugin("meeting-bot", [{ path: "/absolute", kind: "http" }]);

    const res = await approve(
      approveRequest({ digest: "0".repeat(32) }),
      "meeting-bot",
    );

    expect(res.status).toBe(404);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("rejects a malformed digest before touching the store", async () => {
    writePlugin("meeting-bot");

    for (const digest of ["", "not-hex", "ABC", 42, null]) {
      const res = await approve(approveRequest({ digest }), "meeting-bot");
      expect(res.status).toBe(400);
    }
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("rejects a body that is not JSON", async () => {
    writePlugin("meeting-bot");

    const res = await approve(approveRequest("{not json"), "meeting-bot");

    expect(res.status).toBe(400);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });
});

describe("revoke", () => {
  it("removes a grant and reports that it did", async () => {
    writePlugin("meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    const res = await revoke(revokeRequest(), "meeting-bot");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true });
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("reports honestly when there was nothing to revoke", async () => {
    const res = await revoke(revokeRequest(), "meeting-bot");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: false });
  });

  it("revokes a grant whose declaration has become unreadable", async () => {
    // A grant must be withdrawable even when the manifest that justified it
    // can no longer be parsed, or a broken plugin would keep its ingress.
    approvePluginIngress({ plugin: "meeting-bot", digest: "a".repeat(32) });
    writePlugin("meeting-bot", [{ path: "/absolute", kind: "http" }]);

    const res = await revoke(revokeRequest(), "meeting-bot");

    expect(await res.json()).toMatchObject({ revoked: true });
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });
});
