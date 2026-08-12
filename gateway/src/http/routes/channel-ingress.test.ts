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
const revoke = createChannelIngressRevokeHandler();
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
