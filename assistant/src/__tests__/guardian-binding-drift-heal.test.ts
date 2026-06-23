import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { GuardianDelivery } from "@vellumai/gateway-client";

let mockGuardians: GuardianDelivery[] | null = [];

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardians,
  guardianForChannel: (list: GuardianDelivery[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { healGuardianBindingDrift } from "../runtime/guardian-vellum-migration.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

/** Gateway delivery mirroring the local guardian binding's principal. */
function gatewayGuardian(principalId: string): GuardianDelivery {
  return {
    channelType: "vellum",
    contactId: "guardian-contact",
    principalId,
    address: principalId,
    status: "active",
  };
}

describe("healGuardianBindingDrift", () => {
  beforeEach(() => {
    resetTables();
    mockGuardians = [];
  });

  test("heals drift when both principals have vellum-principal- prefix", async () => {
    // Simulate DB reset: new guardian binding with a different UUID
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-new-uuid",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-new-uuid",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("vellum-principal-new-uuid")];

    // Client arrives with the old JWT principal
    const healed = await healGuardianBindingDrift("vellum-principal-old-uuid");
    expect(healed).toBe(true);

    // Guardian binding now matches the old JWT
    const guardian = findGuardianForChannel("vellum");
    expect(guardian).not.toBeNull();
    expect(guardian!.contact.principalId).toBe("vellum-principal-old-uuid");
    expect(guardian!.channel.address).toBe("vellum-principal-old-uuid");
  });

  test("no-op when principals already match", async () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-same",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-same",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("vellum-principal-same")];

    const healed = await healGuardianBindingDrift("vellum-principal-same");
    expect(healed).toBe(false);
  });

  test("refuses to heal when incoming principal lacks vellum-principal- prefix", async () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-aaa",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("vellum-principal-aaa")];

    // External/platform principal — should NOT be adopted
    const healed = await healGuardianBindingDrift("platform-user-12345");
    expect(healed).toBe(false);

    // Guardian unchanged
    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("vellum-principal-aaa");
  });

  test("refuses to heal when stored principal lacks vellum-principal- prefix", async () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "verified-phone-guardian",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "verified-phone-guardian",
      verifiedVia: "challenge",
    });
    mockGuardians = [gatewayGuardian("verified-phone-guardian")];

    // Even with a vellum-principal- incoming, don't overwrite a real binding
    const healed = await healGuardianBindingDrift("vellum-principal-attacker");
    expect(healed).toBe(false);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("verified-phone-guardian");
  });

  test("returns false when gateway reports no guardian binding", async () => {
    mockGuardians = [];
    const healed = await healGuardianBindingDrift("vellum-principal-orphan");
    expect(healed).toBe(false);
  });

  test("returns false when the gateway is unreachable (null list)", async () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-aaa",
      verifiedVia: "startup-migration",
    });
    mockGuardians = null;

    const healed = await healGuardianBindingDrift("vellum-principal-old-uuid");
    expect(healed).toBe(false);
  });
});
