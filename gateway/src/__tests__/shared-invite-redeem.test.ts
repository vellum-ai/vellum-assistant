/**
 * Tests for `POST /v1/shared/invites/redeem`: redeeming a `vellum-shared`
 * invite link token for a trusted-contact principal and token pair, and what
 * that principal can then do.
 *
 * The gateway DB, token minting, the trust verdict resolver and the IPC
 * runtime proxy are real. The daemon IPC socket and feature flags are
 * stubbed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import {
  hashInviteToken,
  ResolveInboundTrustResponseSchema,
} from "@vellumai/gateway-client";
import { and, eq } from "drizzle-orm";

// The route schema the daemon serves: the guardian-only chat route as a
// current daemon ships it, and a route admitting trusted contacts that exists
// only here, to observe an admitted contact reach the daemon.
const ROUTE_SCHEMA = [
  {
    operationId: "messages_post",
    endpoint: "messages",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
      allowedTrustClasses: ["guardian"],
    },
  },
  {
    operationId: "contact_probe",
    endpoint: "contact-probe",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor"],
      allowedTrustClasses: ["guardian", "trusted_contact"],
    },
  },
];

type IpcCall = { method: string; params: unknown };
let ipcCalls: IpcCall[] = [];
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string, params?: unknown) => {
    ipcCalls.push({ method, params });
    if (method === "get_route_schema") return ROUTE_SCHEMA;
    return { ok: true };
  },
}));

let trustedContactsEnabled = true;
const actualFlagResolver = await import("../feature-flag-resolver.js");
mock.module("../feature-flag-resolver.js", () => ({
  ...actualFlagResolver,
  isFeatureFlagEnabled: (flag: string) =>
    flag === "vellum-trusted-contacts" ? trustedContactsEnabled : false,
}));

// Token minting stays real; a test can make the next mint throw to fail a
// redemption after its claim.
let failNextMint = false;
const actualBootstrap = await import("../auth/guardian-bootstrap.js");
// Captured before mocking: the namespace's binding is replaced by the mock.
const realMint = actualBootstrap.mintAndRecordDeviceBoundTokenPair;
mock.module("../auth/guardian-bootstrap.js", () => ({
  ...actualBootstrap,
  mintAndRecordDeviceBoundTokenPair: (
    params: Parameters<typeof realMint>[0],
  ) => {
    if (failNextMint) {
      failNextMint = false;
      throw new Error("token store unavailable");
    }
    return realMint(params);
  },
}));

await import("./test-preload.js");

const { initSigningKey, verifyToken } =
  await import("../auth/token-service.js");
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contactChannels,
  contacts,
  ingressInvites,
} = await import("../db/schema.js");
const { ContactStore } = await import("../db/contact-store.js");
const { validateEdgeToken } = await import("../auth/token-exchange.js");
const { createInviteNative, updateContactChannelCore } =
  await import("../http/routes/contacts-control-plane-proxy.js");
const { handleSharedInviteRedeem, resetSharedInviteRedeemRateLimiterForTests } =
  await import("../http/routes/shared-invite-redeem.js");
const { handleGuardianRefresh } =
  await import("../http/routes/guardian-refresh.js");
const { tryIpcProxy } = await import("../http/routes/ipc-runtime-proxy.js");
const { refreshRouteSchema } = await import("../ipc/route-schema-cache.js");
const { trustVerdictRoutes } = await import("../ipc/trust-verdict-handlers.js");
const { seedContact } = await import("./helpers/contact-fixtures.js");

const CLIENT_IP = "203.0.113.7";
const DEVICE_ID = "shared-device-alice";
const CONTACT_ID = "contact-alice";
const GUARDIAN_ID = "contact-guardian";

type Invite = { id: string; token: string; inviteCode: string };

async function createInvite(
  sourceChannel = "vellum-shared",
  contactId = CONTACT_ID,
): Promise<Invite> {
  const { invite } = await createInviteNative({ contactId, sourceChannel });
  return {
    id: invite.id as string,
    token: invite.token as string,
    inviteCode: invite.inviteCode as string,
  };
}

function redeemRequest(body: unknown): Request {
  return new Request("http://localhost/v1/shared/invites/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function redeem(body: unknown, clientIp = CLIENT_IP): Promise<Response> {
  return handleSharedInviteRedeem(redeemRequest(body), clientIp);
}

type Grant = {
  principalId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

async function redeemOk(invite: Invite): Promise<Grant> {
  const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });
  expect(res.status).toBe(200);
  return (await res.json()) as Grant;
}

function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

function sharedChannelRows() {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.type, "vellum-shared"))
    .all();
}

function contactRow(id: string) {
  return new ContactStore().getContact(id)!;
}

/** The invite is untouched: still active and not consumed. */
function expectInviteUnconsumed(id: string): void {
  const row = inviteRow(id);
  expect(row.status).toBe("active");
  expect(row.useCount).toBe(0);
  expect(sharedChannelRows()).toHaveLength(0);
}

function proxyRequest(path: string, accessToken: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-vellum-proxy-server": "ipc",
    },
    body: "{}",
  });
}

const PROXY_CONFIG = {
  runtimeProxyRequireAuth: true,
} as unknown as Parameters<typeof tryIpcProxy>[1];

async function resolveInboundTrust(principalId: string) {
  const route = trustVerdictRoutes.find(
    (r) => r.method === "resolve_inbound_trust",
  )!;
  const result = await route.handler({
    channelType: "vellum-shared",
    actorExternalId: principalId,
  });
  return ResolveInboundTrustResponseSchema.parse(result);
}

beforeAll(async () => {
  await initGatewayDb();
  await refreshRouteSchema();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(actorTokenRecords).run();
  db.delete(actorRefreshTokenRecords).run();
  db.delete(ingressInvites).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  seedContact({
    id: GUARDIAN_ID,
    displayName: "Bob",
    role: "guardian",
    principalId: "guardian-principal",
  });
  seedContact({ id: CONTACT_ID, displayName: "Alice" });
  ipcCalls = [];
  trustedContactsEnabled = true;
  failNextMint = false;
  resetSharedInviteRedeemRateLimiterForTests();
});

describe("redeeming a vellum-shared invite", () => {
  test("returns the principal and a contact token pair", async () => {
    const invite = await createInvite();
    const before = Date.now();

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const grant = (await res.json()) as Grant;
    expect(Object.keys(grant).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "principalId",
      "refreshToken",
    ]);
    expect(grant.principalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Number.isInteger(grant.expiresAt)).toBe(true);
    expect(grant.expiresAt).toBeGreaterThan(before);

    const claims = verifyToken(grant.accessToken, "vellum-gateway");
    expect(claims.ok && claims.claims.scope_profile).toBe("contact_client_v1");
    expect(claims.ok && claims.claims.sub).toEndWith(`:${grant.principalId}`);

    const [channel] = sharedChannelRows();
    expect(channel).toMatchObject({
      contactId: CONTACT_ID,
      address: grant.principalId,
      status: "active",
      verifiedVia: "invite",
      inviteId: invite.id,
    });
    expect(contactRow(CONTACT_ID).principalId).toBe(grant.principalId);

    const row = inviteRow(invite.id);
    expect(row.status).toBe("redeemed");
    expect(row.useCount).toBe(1);
    expect(row.redeemedByExternalUserId).toBe(grant.principalId);

    const tokenRows = getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.guardianPrincipalId, grant.principalId))
      .all();
    expect(tokenRows.map((r) => r.role)).toEqual(["contact"]);
  });

  test("a second redemption of the same code fails", async () => {
    const invite = await createInvite();
    await redeemOk(invite);

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_OR_EXPIRED_INVITE",
        message: "invalid or expired invite",
      },
    });
    expect(sharedChannelRows()).toHaveLength(1);
  });

  test("an invite for another channel is rejected and not consumed", async () => {
    const invite = await createInvite("telegram");

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expectInviteUnconsumed(invite.id);
    expect(contactRow(CONTACT_ID).principalId).toBeNull();
  });

  test("an expired invite is rejected", async () => {
    const invite = await createInvite();
    getGatewayDb()
      .update(ingressInvites)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(ingressInvites.id, invite.id))
      .run();

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expect(inviteRow(invite.id).status).toBe("expired");
    expect(sharedChannelRows()).toHaveLength(0);
  });

  test("a revoked invite is rejected", async () => {
    const invite = await createInvite();
    new ContactStore().revokeInvite(invite.id);

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expect(inviteRow(invite.id).status).toBe("revoked");
    expect(sharedChannelRows()).toHaveLength(0);
  });

  test("a used-up invite is rejected", async () => {
    const invite = await createInvite();
    getGatewayDb()
      .update(ingressInvites)
      .set({ useCount: 1 })
      .where(eq(ingressInvites.id, invite.id))
      .run();

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expect(inviteRow(invite.id).useCount).toBe(1);
    expect(sharedChannelRows()).toHaveLength(0);
  });

  test("the 6-digit invite code does not redeem", async () => {
    const invite = await createInvite();
    expect(invite.inviteCode).toMatch(/^\d{6}$/);

    const res = await redeem({ code: invite.inviteCode, deviceId: DEVICE_ID });

    expect(res.status).toBe(401);
    expectInviteUnconsumed(invite.id);
  });

  test("an unknown token is rejected", async () => {
    const res = await redeem({ code: "not-a-token", deviceId: DEVICE_ID });
    expect(res.status).toBe(401);
  });
});

describe("creating a vellum-shared invite", () => {
  test("refuses more than one use", async () => {
    let caught: unknown;
    try {
      await createInviteNative({
        contactId: CONTACT_ID,
        sourceChannel: "vellum-shared",
        maxUses: 2,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
    expect(getGatewayDb().select().from(ingressInvites).all()).toHaveLength(0);
  });

  test("accepts a single use", async () => {
    const { invite } = await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
      maxUses: 1,
    });
    expect(invite.maxUses).toBe(1);
  });

  test("leaves other channels free to allow several uses", async () => {
    const { invite } = await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "telegram",
      maxUses: 2,
    });
    expect(invite.maxUses).toBe(2);
  });

  async function expectCreateConflict(contactId: string): Promise<void> {
    let caught: unknown;
    try {
      await createInviteNative({ contactId, sourceChannel: "vellum-shared" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(getGatewayDb().select().from(ingressInvites).all()).toHaveLength(0);
  }

  test("refuses a guardian contact", async () => {
    await expectCreateConflict(GUARDIAN_ID);
  });

  test("refuses a contact that already has a principal", async () => {
    new ContactStore().bindContactPrincipal(CONTACT_ID, "principal-earlier");
    await expectCreateConflict(CONTACT_ID);
  });
});

describe("request validation", () => {
  test("returns 404 while the trusted-contacts flag is off", async () => {
    const invite = await createInvite();
    trustedContactsEnabled = false;

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(404);
    expectInviteUnconsumed(invite.id);
  });

  test("rejects a blank deviceId", async () => {
    const invite = await createInvite();

    const res = await redeem({ code: invite.token, deviceId: "   " });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "deviceId is required" },
    });
    expectInviteUnconsumed(invite.id);
  });

  test("rejects a missing deviceId", async () => {
    const invite = await createInvite();
    const res = await redeem({ code: invite.token });
    expect(res.status).toBe(400);
    expectInviteUnconsumed(invite.id);
  });

  test("rejects a deviceId that is not a string", async () => {
    const invite = await createInvite();

    const res = await redeem({ code: invite.token, deviceId: 42 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "deviceId is required" },
    });
    expectInviteUnconsumed(invite.id);
  });

  test("rejects a missing code", async () => {
    const res = await redeem({ deviceId: DEVICE_ID });
    expect(res.status).toBe(400);
  });

  test("rejects a body that is not JSON", async () => {
    const res = await redeem("not json");
    expect(res.status).toBe(400);
  });

  test("refuses a client after repeated failures, before reading its body", async () => {
    const invite = await createInvite();
    for (let i = 0; i < 10; i++) {
      expect(
        (await redeem({ code: `guess-${i}`, deviceId: DEVICE_ID })).status,
      ).toBe(401);
    }

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expectInviteUnconsumed(invite.id);

    const otherClient = await redeem(
      { code: invite.token, deviceId: DEVICE_ID },
      "198.51.100.4",
    );
    expect(otherClient.status).toBe(200);
  });
});

describe("a failure after the claim leaves the invite redeemable", () => {
  test("when minting the tokens fails", async () => {
    const invite = await createInvite();
    failNextMint = true;

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(500);
    expectInviteUnconsumed(invite.id);
    expect(contactRow(CONTACT_ID).principalId).toBeNull();
    expect(getGatewayDb().select().from(actorTokenRecords).all()).toHaveLength(
      0,
    );

    const grant = await redeemOk(invite);
    expect(contactRow(CONTACT_ID).principalId).toBe(grant.principalId);
  });

  test("when the contact already speaks for another principal", async () => {
    const invite = await createInvite();
    new ContactStore().bindContactPrincipal(CONTACT_ID, "principal-earlier");

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "INVITE_NOT_REDEEMABLE",
        message: "invite can no longer be redeemed",
      },
    });
    expectInviteUnconsumed(invite.id);
    expect(contactRow(CONTACT_ID).principalId).toBe("principal-earlier");
  });

  test("when the invite names the guardian", async () => {
    // Creation refuses this invite, so the row is written directly.
    const invite = {
      id: "invite-guardian",
      token: "guardian-link-token",
      inviteCode: "",
    };
    new ContactStore().createInvite({
      id: invite.id,
      sourceChannel: "vellum-shared",
      tokenHash: hashInviteToken(invite.token),
      contactId: GUARDIAN_ID,
      expiresAt: Date.now() + 60_000,
    });

    const res = await redeem({ code: invite.token, deviceId: DEVICE_ID });

    expect(res.status).toBe(409);
    expectInviteUnconsumed(invite.id);
    expect(contactRow(GUARDIAN_ID).principalId).toBe("guardian-principal");
  });
});

describe("the redeemed principal", () => {
  test("resolves as trusted_contact through the gateway proxy lookup", async () => {
    const grant = await redeemOk(await createInvite());
    ipcCalls = [];

    const res = await tryIpcProxy(
      proxyRequest("/v1/contact-probe", grant.accessToken),
      PROXY_CONFIG,
    );

    expect(res!.status).toBe(200);
    const forwarded = ipcCalls.find((c) => c.method === "contact_probe");
    expect(forwarded).toBeDefined();
    expect(
      (forwarded!.params as { headers: Record<string, string> }).headers[
        "x-vellum-actor-principal-id"
      ],
    ).toBe(grant.principalId);
  });

  test("resolves as trusted_contact through the daemon's shared-principal lookup", async () => {
    const grant = await redeemOk(await createInvite());

    const { verdict } = await resolveInboundTrust(grant.principalId);

    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.resolutionFailed).toBeUndefined();
    expect(verdict.contactId).toBe(CONTACT_ID);
    expect(verdict.memberDisplayName).toBe("Alice");
  });

  test("gets 404 on POST /v1/messages", async () => {
    const grant = await redeemOk(await createInvite());
    ipcCalls = [];

    const res = await tryIpcProxy(
      proxyRequest("/v1/messages", grant.accessToken),
      PROXY_CONFIG,
    );

    expect(res!.status).toBe(404);
    expect(ipcCalls.find((c) => c.method === "messages_post")).toBeUndefined();
  });

  test("refreshes through /v1/guardian/refresh into a contact token", async () => {
    const grant = await redeemOk(await createInvite());
    expect(
      validateEdgeToken(grant.accessToken, { allowExpired: true }).ok,
    ).toBe(true);

    const res = await handleGuardianRefresh(
      new Request("http://localhost/v1/guardian/refresh", {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          refreshToken: grant.refreshToken,
          deviceId: DEVICE_ID,
        }),
      }),
    );

    expect(res.status).toBe(200);
    const rotated = (await res.json()) as {
      guardianPrincipalId: string;
      accessToken: string;
    };
    expect(rotated.guardianPrincipalId).toBe(grant.principalId);
    const claims = verifyToken(rotated.accessToken, "vellum-gateway");
    expect(claims.ok && claims.claims.scope_profile).toBe("contact_client_v1");

    const active = getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(
        and(
          eq(actorTokenRecords.guardianPrincipalId, grant.principalId),
          eq(actorTokenRecords.status, "active"),
        ),
      )
      .all();
    expect(active.map((r) => r.role)).toEqual(["contact"]);

    const probe = await tryIpcProxy(
      proxyRequest("/v1/contact-probe", rotated.accessToken),
      PROXY_CONFIG,
    );
    expect(probe!.status).toBe(200);
  });

  test("is refused on its next request once its channel is revoked", async () => {
    const grant = await redeemOk(await createInvite());
    const before = await tryIpcProxy(
      proxyRequest("/v1/contact-probe", grant.accessToken),
      PROXY_CONFIG,
    );
    expect(before!.status).toBe(200);

    const [channel] = sharedChannelRows();
    await updateContactChannelCore({
      contactChannelId: channel!.id,
      status: "revoked",
      reason: "access removed",
    });
    ipcCalls = [];

    const after = await tryIpcProxy(
      proxyRequest("/v1/contact-probe", grant.accessToken),
      PROXY_CONFIG,
    );

    expect(after!.status).toBe(404);
    expect(ipcCalls.find((c) => c.method === "contact_probe")).toBeUndefined();
    const { verdict } = await resolveInboundTrust(grant.principalId);
    expect(verdict.trustClass).toBe("unknown");
  });
});
