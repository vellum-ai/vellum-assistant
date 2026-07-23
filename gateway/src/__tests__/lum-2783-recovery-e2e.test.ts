/**
 * End-to-end proof for LUM-2783.
 *
 * Reproduces the exact broken state an upgraded install lands in — the gateway
 * `contacts` table empty (its contact reconcile bailed because migration 305
 * had already dropped the assistant ACL columns) while the actor tokens `m0002`
 * migrated into the gateway survive — then runs the REAL production paths in
 * sequence:
 *
 *   1. the canonical classifier `resolveTrustVerdict` BEFORE recovery, to
 *      confirm the reported symptom (`trust_class: unknown`), then
 *   2. the boot backfill `ensureVellumGuardianBinding({ recoverFromActorTokens })`
 *      that runs post-assistant-ready, then
 *   3. `resolveTrustVerdict` AGAIN, to confirm a new vellum turn now classifies
 *      the guardian and carries a real canonical identity.
 *
 * Nothing here is stubbed for the classifier or the recovery — both read the
 * same real gateway DB. Only createGuardianBinding's best-effort assistant-DB
 * mirror dials IPC, which is absent in-test and swallowed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "./test-preload.js";

import {
  ensureVellumGuardianBinding,
  VellumGuardianMintRefusedError,
} from "../auth/guardian-bootstrap.js";
import { bustGuardianIntegrityCache } from "../auth/guardian-integrity.js";
import { initSigningKey } from "../auth/token-service.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { actorTokenRecords, contacts, contactChannels } from "../db/schema.js";
import {
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} from "../guardian-integrity-reporter.js";
import { resolveTrustVerdict } from "../risk/trust-verdict-resolver.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

const PRINCIPAL = "vellum-principal-0aafaf2";

function seedActiveActorToken(guardianPrincipalId: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: `tok-${guardianPrincipalId}`,
      tokenHash: `hash-${guardianPrincipalId}`,
      guardianPrincipalId,
      hashedDeviceId: "device-1",
      platform: "macos",
      status: "active",
      issuedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function vellumVerdictFor(principal: string) {
  // A fresh classification, as a new thread would trigger.
  bustGuardianIntegrityCache();
  return resolveTrustVerdict({
    channelType: "vellum",
    actorExternalId: principal,
  });
}

beforeEach(async () => {
  await initGatewayDb();
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  db.delete(actorTokenRecords).run();
  bustGuardianIntegrityCache();
  resetGuardianIntegrityReporterForTesting();
  setGuardianIntegrityReporterOverridesForTesting({
    fetchImpl: async () => new Response("{}"),
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: { error: () => {}, warn: () => {} },
  });
});

afterEach(() => {
  resetGuardianIntegrityReporterForTesting();
  resetGatewayDb();
});

describe("LUM-2783 end-to-end: broken state → boot recovery → trust resolves guardian", () => {
  test("empty contacts + active token: a new vellum turn resolves guardian, not unknown", async () => {
    // The broken state: no contacts, surviving active actor token.
    seedActiveActorToken(PRINCIPAL);

    // The reported symptom, straight from the canonical classifier.
    const before = await vellumVerdictFor(PRINCIPAL);
    expect(before.trustClass).toBe("unknown");

    // Boot backfill (post-assistant-ready) self-heals from the token.
    const recovered = await ensureVellumGuardianBinding({
      recoverFromActorTokens: true,
    });
    expect(recovered).toBe(PRINCIPAL);

    // A new thread now classifies the guardian with a real canonical identity.
    const after = await vellumVerdictFor(PRINCIPAL);
    expect(after.trustClass).toBe("guardian");
    expect(after.canonicalSenderId).toBe(PRINCIPAL); // no longer `unknown`
  });

  test("principal-less contact-prompt stub + active token: still self-heals", async () => {
    // A gateway-first contact-prompt stub (role=guardian, null principal, no
    // active binding) plus the surviving token. The stub must not block the heal.
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "stub-contact",
        displayName: "stub",
        role: "guardian",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "stub-channel",
        contactId: "stub-contact",
        type: "vellum",
        address: "stub-addr",
        isPrimary: true,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    seedActiveActorToken(PRINCIPAL);

    expect((await vellumVerdictFor(PRINCIPAL)).trustClass).toBe("unknown");

    const recovered = await ensureVellumGuardianBinding({
      recoverFromActorTokens: true,
    });
    expect(recovered).toBe(PRINCIPAL);

    const after = await vellumVerdictFor(PRINCIPAL);
    expect(after.trustClass).toBe("guardian");
    expect(after.canonicalSenderId).toBe(PRINCIPAL);
  });

  test("guardian gone with NO active token: fails closed, never fabricates an identity", async () => {
    // Row 5: evidence exists (a revoked token) but nothing active to recover
    // from. The backfill must refuse rather than invent a guardian, and the
    // classifier stays `unknown` (fail-closed, repairable by re-pair).
    const now = Date.now();
    getGatewayDb()
      .insert(actorTokenRecords)
      .values({
        id: "tok-revoked",
        tokenHash: "hash-revoked",
        guardianPrincipalId: PRINCIPAL,
        hashedDeviceId: "device-x",
        platform: "macos",
        status: "revoked",
        issuedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await expect(
      ensureVellumGuardianBinding({ recoverFromActorTokens: true }),
    ).rejects.toBeInstanceOf(VellumGuardianMintRefusedError);

    const after = await vellumVerdictFor(PRINCIPAL);
    expect(after.trustClass).toBe("unknown");
    // No guardian was fabricated.
    expect(getGatewayDb().select().from(contacts).all()).toHaveLength(0);
  });
});
