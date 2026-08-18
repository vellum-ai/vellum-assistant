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
import { IngressInboundSchema } from "./ingress-inbound.js";
import {
  PLUGIN_INGRESS_MANIFEST_RELPATH,
  type IngressRoute,
} from "./plugin-ingress.js";
import {
  findServableRoute,
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
    handshake: "signed-headers" as const,
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

/**
 * A declared route, defaulted so each case states only what it is about.
 *
 * The digest takes whole `IngressRoute`s — it is computed from real
 * declarations, and a partial shape here would let a field be added to the
 * declaration without any of these cases noticing it is now covered.
 */
function route(
  overrides: Partial<IngressRoute> & { path: string },
): IngressRoute {
  return {
    kind: "http",
    signer: "plugin",
    handshake: "signed-headers",
    description: "events",
    ...overrides,
  };
}

describe("ingressDeclarationDigest", () => {
  it("is stable across route ordering", () => {
    expect(
      ingressDeclarationDigest([route({ path: "a" }), route({ path: "b" })]),
    ).toBe(
      ingressDeclarationDigest([route({ path: "b" }), route({ path: "a" })]),
    );
  });

  it("ignores a description reword so an approval survives it", () => {
    expect(
      ingressDeclarationDigest([route({ path: "a", description: "reworded" })]),
    ).toBe(
      ingressDeclarationDigest([route({ path: "a", description: "one" })]),
    );
  });

  it("changes when the signer changes", () => {
    // Switching signer changes whose key opens the route, so an approval for
    // one must not carry over to the other.
    expect(
      ingressDeclarationDigest([route({ path: "a", signer: "vellum" })]),
    ).not.toBe(ingressDeclarationDigest([route({ path: "a" })]));
  });

  it("keeps the digest a default-scheme route had before handshake existed", () => {
    // Golden values from the `kind signer path` encoding that shipped before
    // this field. Approvals are persisted digests, so if these move, every
    // already-approved plugin silently drops back to pending and 404s until a
    // guardian approves it again. Adding a field must not do that.
    expect(
      ingressDeclarationDigest([
        route({ path: "realtime", kind: "websocket" }),
      ]),
    ).toBe("a32e2511180b489c31e147ebb926e72b");
    expect(
      ingressDeclarationDigest([route({ path: "hook", signer: "vellum" })]),
    ).toBe("db809d978434fd3804c8faad82851069");
  });

  it("keeps the digest a route had before verification existed", () => {
    // Same golden guarantee as the handshake default: a route that declares
    // no descriptor must digest exactly as it did before the field, or every
    // approved plugin drops back to pending on upgrade.
    expect(
      ingressDeclarationDigest([
        route({ path: "hook", verification: undefined }),
      ]),
    ).toBe(ingressDeclarationDigest([route({ path: "hook" })]));
  });

  it("changes when a route gains a verification descriptor", () => {
    // The descriptor decides which secret and which bytes make a delivery
    // authentic. A guardian approved a route verified one way, not any way.
    const verification = {
      kind: "hmac" as const,
      algorithm: "sha256" as const,
      secret: { field: "comms_webhook_secret" },
      signature: {
        header: "X-Osis-Signature",
        encoding: "hex" as const,
        prefix: "sha256=",
      },
      payload: ["body" as const],
    };
    const declared = route({ path: "events-comms", verification });

    expect(ingressDeclarationDigest([declared])).not.toBe(
      ingressDeclarationDigest([route({ path: "events-comms" })]),
    );
    expect(
      ingressDeclarationDigest([
        route({
          path: "events-comms",
          verification: { ...verification, secret: { field: "other_secret" } },
        }),
      ]),
    ).not.toBe(ingressDeclarationDigest([declared]));
  });

  it("changes when the handshake scheme changes", () => {
    // signed-query makes the URL itself the credential. A guardian who
    // approved the header scheme has not approved that.
    expect(
      ingressDeclarationDigest([
        route({ path: "a", kind: "websocket", handshake: "signed-query" }),
      ]),
    ).not.toBe(
      ingressDeclarationDigest([route({ path: "a", kind: "websocket" })]),
    );
  });

  it("changes when reach widens or a transport changes", () => {
    const base = ingressDeclarationDigest([route({ path: "a" })]);

    expect(
      ingressDeclarationDigest([route({ path: "a" }), route({ path: "b" })]),
    ).not.toBe(base);
    expect(
      ingressDeclarationDigest([route({ path: "a", kind: "websocket" })]),
    ).not.toBe(base);
  });

  it("changes when a route starts delivering messages", () => {
    // Receiving a callback and being able to start a conversation are not the
    // same grant, so the second must not begin under an approval for the first.
    expect(
      ingressDeclarationDigest([
        route({ path: "a", inbound: IngressInboundSchema.parse({}) }),
      ]),
    ).not.toBe(ingressDeclarationDigest([route({ path: "a" })]));
  });

  it("changes when a delivering route starts reading a field elsewhere", () => {
    // Which key the sender is read from decides who the message is from.
    const declared = route({
      path: "a",
      inbound: IngressInboundSchema.parse({}),
    });

    expect(
      ingressDeclarationDigest([
        route({
          path: "a",
          inbound: IngressInboundSchema.parse({
            fields: { actorExternalId: "from" },
          }),
        }),
      ]),
    ).not.toBe(ingressDeclarationDigest([declared]));
  });

  it("leaves a route declaring no delivery encoded as it always was", () => {
    // Introducing the field must not silently re-digest every unchanged
    // manifest, drop each back to pending, and 404 routes a guardian already
    // approved. This is the digest as it stood before `inbound` existed.
    expect(ingressDeclarationDigest([route({ path: "a" })])).toBe(
      "45e87741e530e330a663d4c0bb493c36",
    );
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

describe("findServableRoute", () => {
  const http = (signer: "plugin" | "vellum") => ({
    path: "hook",
    kind: "http" as const,
    signer,
    handshake: "signed-headers" as const,
    description: "d",
  });

  function resolution(
    over: Partial<{
      approved: { plugin: string; routes: unknown[]; digest: string }[];
      pending: { plugin: string; routes: unknown[]; digest: string }[];
    }> = {},
  ) {
    return {
      approved: [],
      pending: [],
      problems: [],
      ...over,
    } as never;
  }

  it("serves an approved route", () => {
    const res = resolution({
      approved: [
        { plugin: "p", routes: [http("plugin")], digest: "d".repeat(32) },
      ],
    });
    expect(findServableRoute(res, "p", "hook", "http")?.path).toBe("hook");
  });

  it("does not serve a plugin-signed route awaiting approval", () => {
    const res = resolution({
      pending: [
        { plugin: "p", routes: [http("plugin")], digest: "d".repeat(32) },
      ],
    });
    expect(findServableRoute(res, "p", "hook", "http")).toBeUndefined();
  });

  it("serves a vellum-signed route without approval", () => {
    // Only a caller holding the platform secret can open it, and that trust
    // was already given when the account was connected.
    const res = resolution({
      pending: [
        { plugin: "p", routes: [http("vellum")], digest: "d".repeat(32) },
      ],
    });
    expect(findServableRoute(res, "p", "hook", "http")?.signer).toBe("vellum");
  });

  it("still matches on kind and path exactly", () => {
    const res = resolution({
      pending: [
        { plugin: "p", routes: [http("vellum")], digest: "d".repeat(32) },
      ],
    });
    // The exemption is about approval, not about widening reach.
    expect(findServableRoute(res, "p", "hook", "websocket")).toBeUndefined();
    expect(findServableRoute(res, "p", "other", "http")).toBeUndefined();
    expect(findServableRoute(res, "other", "hook", "http")).toBeUndefined();
  });

  it("ignores one trailing slash on the requested path", () => {
    // Senders add it: a provider handed `.../hook` may call `.../hook/`.
    const res = resolution({
      approved: [
        { plugin: "p", routes: [http("plugin")], digest: "d".repeat(32) },
      ],
    });
    expect(findServableRoute(res, "p", "hook/", "http")?.path).toBe("hook");
  });

  it("does not let a trailing slash reach past a declaration", () => {
    // A declared path may not end in a slash (see `IngressRouteSchema`), so
    // dropping one can only ever land back on the path that was declared.
    const res = resolution({
      approved: [
        { plugin: "p", routes: [http("plugin")], digest: "d".repeat(32) },
      ],
    });
    expect(findServableRoute(res, "p", "hook//", "http")).toBeUndefined();
    expect(findServableRoute(res, "p", "hook/more", "http")).toBeUndefined();
    expect(findServableRoute(res, "p", "hook/more/", "http")).toBeUndefined();
  });

  it("serves nothing for a declaration that failed validation", () => {
    // A malformed manifest lands in `problems`, never in either list, so a
    // vellum signer cannot smuggle an invalid route through.
    const res = resolution({});
    expect(findServableRoute(res, "p", "hook", "http")).toBeUndefined();
  });
});
