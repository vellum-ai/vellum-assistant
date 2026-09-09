import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import {
  ingressDeclarationDigest,
  resolvePluginIngress,
} from "../../channels/plugin-ingress-approvals.js";
import {
  PLUGIN_INGRESS_MANIFEST_RELPATH,
  type IngressRoute,
} from "../../channels/plugin-ingress.js";
import {
  reconcilePluginWebhookRoutes,
  watchPluginIngressForWebhookRoutes,
} from "../../channels/plugin-webhook-route-sync.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import {
  approvePluginIngress,
  getPluginIngressApproval,
} from "../../db/plugin-ingress-approval-store.js";
import {
  pluginIngressApprovals,
  webhookIngressRoutes,
} from "../../db/schema.js";
import {
  listWebhookIngressRoutes,
  reconcilePluginWebhookIngressRoutes,
  registerWebhookIngressRoute,
} from "../../db/webhook-ingress-route-store.js";
import {
  createChannelIngressApproveHandler,
  createChannelIngressListHandler,
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
const revoke = createChannelIngressRevokeHandler(() =>
  resolvePluginIngress({ workspaceDir }),
);
const list = createChannelIngressListHandler(() =>
  resolvePluginIngress({ workspaceDir }),
);

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
  getGatewayDb().delete(webhookIngressRoutes).run();

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

  it("claims both accepted spellings of every route it approves", async () => {
    // Velay forwards only paths this assistant has claimed, and matches them
    // exactly, so a grant that wrote no row for the trailing-slash spelling
    // leaves a request the gateway would answer rejected at the edge.
    const routes = [ROUTES[0]!, { ...ROUTES[0]!, path: "events/inbound" }];
    writePlugin("meeting-bot", routes);

    const res = await approve(
      approveRequest({ digest: ingressDeclarationDigest(routes) }),
      "meeting-bot",
    );

    expect(res.status).toBe(200);
    expect(
      listWebhookIngressRoutes()
        .map((r) => [r.path, r.type, r.source])
        .sort(),
    ).toEqual([
      ["/webhooks/plugins/meeting-bot/events/inbound", "plugin", "meeting-bot"],
      [
        "/webhooks/plugins/meeting-bot/events/inbound/",
        "plugin",
        "meeting-bot",
      ],
      ["/webhooks/plugins/meeting-bot/realtime", "plugin", "meeting-bot"],
      ["/webhooks/plugins/meeting-bot/realtime/", "plugin", "meeting-bot"],
    ]);
  });

  it("claims paths for a grant that was recorded before the registry existed", async () => {
    // Nothing ever wrote that grant's rows and no second approval is coming
    // for it, so only a reconcile can give it any reach. Approving anything
    // reconciles the whole set, which is what picks it up.
    writePlugin("meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });
    expect(listWebhookIngressRoutes()).toEqual([]);
    writePlugin("notes");

    const res = await approve(
      new Request("http://gateway/v1/channel-ingress/notes/approve", {
        method: "POST",
        body: JSON.stringify({ digest: ingressDeclarationDigest(ROUTES) }),
      }),
      "notes",
    );

    expect(res.status).toBe(200);
    expect(
      listWebhookIngressRoutes()
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      "/webhooks/plugins/meeting-bot/realtime",
      "/webhooks/plugins/meeting-bot/realtime/",
      "/webhooks/plugins/notes/realtime",
      "/webhooks/plugins/notes/realtime/",
    ]);
  });

  it("leaves a settle that failed for the watcher to retry", async () => {
    // The grant is persisted before its rows are claimed, and no declaration
    // change follows an approval, so a settle that throws would strand the
    // approved routes unless the failure arms the poll's retry.
    writePlugin("meeting-bot");
    const resolve = () => resolvePluginIngress({ workspaceDir });
    // Start from a settled registry, so the retry below is this failure's.
    expect(reconcilePluginWebhookRoutes(resolve)).toBe(true);

    let calls = 0;
    const approveThenFail = createChannelIngressApproveHandler(() => {
      calls += 1;
      if (calls > 1) {
        throw new Error("transient");
      }
      return resolve();
    });

    const res = await approveThenFail(
      approveRequest({ digest: ingressDeclarationDigest(ROUTES) }),
      "meeting-bot",
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(getPluginIngressApproval("meeting-bot")).toBeDefined();
    expect(listWebhookIngressRoutes()).toEqual([]);

    const unwatch = watchPluginIngressForWebhookRoutes({
      subscribe: () => () => {},
      resolve,
      refresh: () => {},
      pollIntervalMs: 10,
    });
    await new Promise((done) => setTimeout(done, 40));
    unwatch();

    expect(
      listWebhookIngressRoutes()
        .map((r) => r.path)
        .sort(),
    ).toEqual([
      "/webhooks/plugins/meeting-bot/realtime",
      "/webhooks/plugins/meeting-bot/realtime/",
    ]);
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

  async function approveWithClaimedPath(): Promise<void> {
    writePlugin("meeting-bot");
    await approve(
      approveRequest({ digest: ingressDeclarationDigest(ROUTES) }),
      "meeting-bot",
    );
    expect(listWebhookIngressRoutes()).toHaveLength(2);
  }

  it("drops the paths the grant claimed", async () => {
    await approveWithClaimedPath();

    const res = await revoke(revokeRequest(), "meeting-bot");

    expect(await res.json()).toMatchObject({ revoked: true });
    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("keeps the paths approval never gated", async () => {
    // A `signer: "vellum"` route is served whether or not a grant stands, so
    // an allowlist that dropped it would block a route the gateway answers.
    const mixed: IngressRoute[] = [
      ROUTES[0]!,
      {
        path: "platform",
        kind: "http",
        signer: "vellum",
        handshake: "signed-headers",
        description: "platform callback",
      },
    ];
    writePlugin("meeting-bot", mixed);
    await approve(
      approveRequest({ digest: ingressDeclarationDigest(mixed) }),
      "meeting-bot",
    );
    expect(listWebhookIngressRoutes()).toHaveLength(4);

    await revoke(revokeRequest(), "meeting-bot");

    expect(listWebhookIngressRoutes().map((r) => r.path)).toEqual([
      "/webhooks/plugins/meeting-bot/platform",
      "/webhooks/plugins/meeting-bot/platform/",
    ]);
  });

  it("revokes a grant whose declaration has become unreadable", async () => {
    // A grant must be withdrawable even when the manifest that justified it
    // cannot be parsed, or a broken plugin would keep its ingress.
    approvePluginIngress({ plugin: "meeting-bot", digest: "a".repeat(32) });
    writePlugin("meeting-bot", [{ path: "/absolute", kind: "http" }]);

    const res = await revoke(revokeRequest(), "meeting-bot");

    expect(await res.json()).toMatchObject({ revoked: true });
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });
});

describe("webhook route reconciliation", () => {
  // Approve and revoke both settle the whole registry against what the gate
  // would serve, so either drives these. Revoking a source that holds no grant
  // is the smallest trigger that changes nothing else.
  const reconcile = () =>
    revoke(
      new Request("http://gateway/v1/channel-ingress/notes/revoke", {
        method: "POST",
      }),
      "notes",
    );

  it("releases the paths of a plugin that is not installed", async () => {
    // An approval outlives the plugin it was granted for, because uninstalling
    // does not revoke. What decides is the declaration, and an absent plugin
    // makes none.
    approvePluginIngress({ plugin: "gone", digest: "a".repeat(32) });
    // A reconcile is the only writer of plugin rows, so it is also how the
    // registry comes to hold one for a plugin that is now absent.
    reconcilePluginWebhookIngressRoutes([
      { path: "/webhooks/plugins/gone/events", source: "gone" },
    ]);

    await reconcile();

    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("releases the paths of an approval the declaration has outgrown", async () => {
    // An edited manifest carries a different digest, which leaves the source
    // pending. The grant then covers a declaration nobody makes, and the
    // source name alone is not enough to keep a path claimed.
    writePlugin("meeting-bot");
    await approve(
      approveRequest({ digest: ingressDeclarationDigest(ROUTES) }),
      "meeting-bot",
    );
    writePlugin("meeting-bot", [{ ...ROUTES[0]!, path: "realtime/v2" }]);

    await reconcile();

    expect(listWebhookIngressRoutes()).toEqual([]);
  });

  it("leaves rows another subsystem registered alone", async () => {
    registerWebhookIngressRoute({
      path: "/webhooks/telegram",
      type: "telegram",
      source: "meeting-bot",
    });

    await reconcile();

    expect(listWebhookIngressRoutes().map((r) => r.type)).toEqual(["telegram"]);
  });
});

describe("list", () => {
  it("says what is pending and which digest would approve it", async () => {
    // The only place this is visible. On the public surface a route held back
    // by approval 404s exactly like one nobody declared.
    writePlugin("meeting-bot");

    const body = (await (await list()).json()) as {
      sources: { source: string; state: string; digest: string }[];
    };

    expect(body.sources).toEqual([
      {
        source: "meeting-bot",
        state: "pending",
        digest: ingressDeclarationDigest(ROUTES),
        routes: [
          {
            path: "realtime",
            publicPath: "/webhooks/plugins/meeting-bot/realtime",
            kind: "websocket",
            signer: "plugin",
            handshake: "signed-headers",
            description: "events",
            credential: "credential/meeting-bot/webhook_secret",
            served: false,
            deliversInbound: false,
          },
        ],
      },
    ] as never);
  });

  it("names the credential a declared verification scheme keys on", async () => {
    // A route can be approved and still 409 on a secret nobody set, so the
    // key it reads is part of what makes the state diagnosable.
    writePlugin("meeting-bot", [
      {
        path: "events-comms",
        kind: "http",
        description: "inbound",
        verification: {
          kind: "hmac",
          algorithm: "sha256",
          secret: { field: "comms_webhook_secret" },
          signature: { header: "X-Osis-Signature", encoding: "hex" },
          payload: ["body"],
        },
      },
    ]);

    const body = (await (await list()).json()) as {
      sources: { routes: Record<string, unknown>[] }[];
    };

    expect(body.sources[0]!.routes[0]).toMatchObject({
      credential: "credential/meeting-bot/comms_webhook_secret",
      verification: {
        algorithm: "sha256",
        signatureHeader: "X-Osis-Signature",
      },
    });
  });

  it("summarises a Standard Webhooks declaration the same way", async () => {
    writePlugin("meeting-bot", [
      {
        path: "events-linq",
        kind: "http",
        description: "inbound",
        verification: {
          kind: "standard-webhooks",
          secret: { field: "linq_webhook_secret" },
        },
      },
    ]);

    const body = (await (await list()).json()) as {
      sources: { routes: Record<string, unknown>[] }[];
    };

    expect(body.sources[0]!.routes[0]).toMatchObject({
      credential: "credential/meeting-bot/linq_webhook_secret",
      verification: {
        algorithm: "sha256",
        signatureHeader: "webhook-signature",
      },
    });
  });

  it("reports an approved declaration as approved", async () => {
    writePlugin("meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    const body = (await (await list()).json()) as {
      sources: { state: string; approvedAt: number }[];
    };

    expect(body.sources[0]!.state).toBe("approved");
    expect(body.sources[0]!.approvedAt).toBeGreaterThan(0);
  });

  it("distinguishes an edited declaration from one never approved", async () => {
    // Both are pending. Only one of them is a guardian re-reading a change
    // they already decided on once.
    writePlugin("meeting-bot");
    approvePluginIngress({ plugin: "meeting-bot", digest: "a".repeat(32) });

    const body = (await (await list()).json()) as {
      sources: { state: string; digest: string; approvedDigest?: string }[];
    };

    expect(body.sources[0]!.state).toBe("pending");
    expect(body.sources[0]!.approvedDigest).toBe("a".repeat(32));
    expect(body.sources[0]!.digest).toBe(ingressDeclarationDigest(ROUTES));
  });

  it("reports a declaration that failed validation and why", async () => {
    // Unservable regardless of approval, so a guardian hunting a missing
    // route needs the reason rather than an absence.
    writePlugin("meeting-bot", [{ path: "/absolute", kind: "http" }]);

    const body = (await (await list()).json()) as {
      sources: unknown[];
      problems: { source: string; reason: string }[];
    };

    expect(body.sources).toEqual([]);
    expect(body.problems[0]!.source).toBe("meeting-bot");
    expect(body.problems[0]!.reason).toContain("path");
  });

  it("reports a vellum-signed route as served while its source waits", async () => {
    // Approval is the general gate, and a vellum-signed route is the
    // exception: only a caller holding the platform secret can open it. A
    // listing that read servability off the source's state would call a live
    // route dormant, and say nothing about which half of a mixed declaration
    // is already reachable.
    writePlugin("meeting-bot", [
      { ...ROUTES[0]!, path: "ours", signer: "vellum" },
      { ...ROUTES[0]!, path: "theirs" },
    ]);

    const body = (await (await list()).json()) as {
      sources: { state: string; routes: { path: string; served: boolean }[] }[];
    };

    expect(body.sources[0]!.state).toBe("pending");
    expect(body.sources[0]!.routes.map((r) => [r.path, r.served])).toEqual([
      ["ours", true],
      ["theirs", false],
    ]);
  });

  it("reports every route of an approved declaration as served", async () => {
    writePlugin("meeting-bot");
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: ingressDeclarationDigest(ROUTES),
    });

    const body = (await (await list()).json()) as {
      sources: { routes: { served: boolean }[] }[];
    };

    expect(body.sources[0]!.routes[0]!.served).toBe(true);
  });
});
