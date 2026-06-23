/**
 * Tests for the gateway-side guardian binding + delivery resolver.
 *
 * Seeds the gateway ACL DB directly (contacts + contact_channels) and asserts
 * that every active guardian channel is returned (with correct delivery
 * fields), that non-active channels and non-guardian contacts are excluded,
 * that the `channelTypes` filter narrows the result, and that the handler
 * fails soft to [] when the resolver throws.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

await import("./test-preload.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } = await import(
  "../db/connection.js"
);
const { contacts: gwContacts, contactChannels: gwContactChannels } =
  await import("../db/schema.js");
const { resolveGuardianDelivery } = await import(
  "../risk/guardian-delivery-resolver.js"
);

function insertContact(args: {
  id: string;
  displayName: string;
  role?: string;
  principalId?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContacts)
    .values({
      id: args.id,
      displayName: args.displayName,
      role: args.role ?? "contact",
      principalId: args.principalId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function insertChannel(args: {
  id: string;
  contactId: string;
  type: string;
  address: string;
  externalChatId?: string | null;
  status?: string;
  policy?: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContactChannels)
    .values({
      id: args.id,
      contactId: args.contactId,
      type: args.type,
      address: args.address,
      externalChatId: args.externalChatId ?? null,
      status: args.status ?? "active",
      policy: args.policy ?? "allow",
      verifiedAt: args.verifiedAt ?? now,
      verifiedVia: args.verifiedVia ?? "challenge",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  // initGatewayDb reconnects to the same on-disk DB, so clear any rows a prior
  // test left behind (channels first — FK cascade from contacts).
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
});

afterEach(() => {
  resetGatewayDb();
});

describe("resolveGuardianDelivery", () => {
  test("active phone + telegram guardian channels → both returned with fields", () => {
    insertContact({
      id: "c-guardian",
      displayName: "The Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-phone",
      contactId: "c-guardian",
      type: "phone",
      address: "+15555550100",
      externalChatId: null,
      verifiedAt: 1000,
    });
    insertChannel({
      id: "ch-telegram",
      contactId: "c-guardian",
      type: "telegram",
      address: "U_GUARDIAN",
      externalChatId: "chat-guardian",
      verifiedAt: 2000,
    });

    const result = resolveGuardianDelivery({});

    expect(result).toHaveLength(2);
    const byType = Object.fromEntries(result.map((g) => [g.channelType, g]));
    expect(byType.phone).toMatchObject({
      channelType: "phone",
      contactId: "c-guardian",
      principalId: "principal-1",
      displayName: "The Guardian",
      address: "+15555550100",
      externalChatId: null,
      status: "active",
      verifiedAt: 1000,
    });
    expect(byType.telegram).toMatchObject({
      channelType: "telegram",
      address: "U_GUARDIAN",
      externalChatId: "chat-guardian",
      verifiedAt: 2000,
    });
  });

  test("revoked/blocked guardian channels are excluded", () => {
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
    });
    insertChannel({
      id: "ch-active",
      contactId: "c-guardian",
      type: "telegram",
      address: "U_ACTIVE",
      status: "active",
    });
    insertChannel({
      id: "ch-revoked",
      contactId: "c-guardian",
      type: "phone",
      address: "+15555550111",
      status: "revoked",
    });
    insertChannel({
      id: "ch-blocked",
      contactId: "c-guardian",
      type: "slack",
      address: "U_BLOCKED",
      status: "blocked",
    });

    const result = resolveGuardianDelivery({});

    expect(result).toHaveLength(1);
    expect(result[0]?.channelType).toBe("telegram");
    expect(result[0]?.address).toBe("U_ACTIVE");
  });

  test("channelTypes filter narrows the result", () => {
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
    });
    insertChannel({
      id: "ch-phone",
      contactId: "c-guardian",
      type: "phone",
      address: "+15555550100",
    });
    insertChannel({
      id: "ch-telegram",
      contactId: "c-guardian",
      type: "telegram",
      address: "U_GUARDIAN",
    });

    const result = resolveGuardianDelivery({ channelTypes: ["telegram"] });

    expect(result).toHaveLength(1);
    expect(result[0]?.channelType).toBe("telegram");
  });

  test("no guardian → empty array", () => {
    insertContact({ id: "c-member", displayName: "Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      type: "telegram",
      address: "U_MEMBER",
    });

    expect(resolveGuardianDelivery({})).toEqual([]);
  });

  test("non-guardian contact's active channel is NOT returned", () => {
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      type: "telegram",
      address: "U_GUARDIAN",
    });
    insertContact({ id: "c-member", displayName: "Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      type: "telegram",
      address: "U_MEMBER",
    });

    const result = resolveGuardianDelivery({});

    expect(result).toHaveLength(1);
    expect(result[0]?.contactId).toBe("c-guardian");
  });
});

describe("guardianDeliveryRoutes handler", () => {
  test("resolver throw → handler propagates (server maps to error envelope → daemon null)", async () => {
    mock.module("../risk/guardian-delivery-resolver.js", () => ({
      resolveGuardianDelivery: () => {
        throw new Error("boom");
      },
    }));
    const { guardianDeliveryRoutes } = await import(
      "../ipc/guardian-delivery-handlers.js"
    );

    const route = guardianDeliveryRoutes[0]!;
    // A resolver error must NOT be swallowed into {guardians:[]}: it propagates
    // so the IPC server returns an error envelope, which the daemon reader maps
    // to `null` ("couldn't determine") rather than an authoritative empty list.
    expect(route.handler({})).rejects.toThrow("boom");

    mock.restore();
  });

  test("successful resolve with no guardian → handler returns { guardians: [] }", async () => {
    mock.module("../risk/guardian-delivery-resolver.js", () => ({
      resolveGuardianDelivery: () => [],
    }));
    const { guardianDeliveryRoutes } = await import(
      "../ipc/guardian-delivery-handlers.js"
    );

    const route = guardianDeliveryRoutes[0]!;
    expect(await route.handler({})).toEqual({ guardians: [] });

    mock.restore();
  });
});
