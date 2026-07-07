/**
 * Guardian-integrity stamping in the trust-verdict resolver:
 *
 *  - Onboarded-evidence DB with zero guardian rows → every `unknown`
 *    classification carries `resolutionFailed: true` (consumers fail closed).
 *  - Non-unknown classifications (e.g. an intact trusted contact) are never
 *    stamped by the integrity check.
 *  - Fresh install and healthy (guardian present) install → verdicts
 *    unchanged, no `resolutionFailed`.
 *  - A thrown integrity check degrades to the plain unknown verdict — no
 *    crash, no stamp.
 *
 * The fail-loud reporter is mocked so no relay leaves the test process.
 */
import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";

mock.module("../guardian-integrity-reporter.js", () => ({
  reportMissingGuardian: () => {},
}));

await import("./test-preload.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } = await import(
  "../db/connection.js"
);
const {
  contacts,
  contactChannels,
  actorTokenRecords,
  actorRefreshTokenRecords,
} = await import("../db/schema.js");
const { seedActorToken, seedContact } = await import(
  "./helpers/contact-fixtures.js"
);
const { bustGuardianIntegrityCache } = await import(
  "../auth/guardian-integrity.js"
);
const { resolveTrustVerdict } = await import(
  "../risk/trust-verdict-resolver.js"
);

const CHANNEL = "telegram";

function insertGuardianContact(id: string): void {
  seedContact({ id, role: "guardian", principalId: "principal-123" });
}

function insertChannel(args: {
  id: string;
  contactId: string;
  address: string;
  status?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: args.id,
      contactId: args.contactId,
      type: CHANNEL,
      address: args.address,
      status: args.status ?? "active",
      policy: "allow",
      verifiedAt: now,
      verifiedVia: "challenge",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  getGatewayDb().delete(actorTokenRecords).run();
  getGatewayDb().delete(actorRefreshTokenRecords).run();
  bustGuardianIntegrityCache();
});

afterEach(() => {
  resetGatewayDb();
});

describe("missing-guardian state (evidence, zero guardian rows)", () => {
  test("stranger verdict carries resolutionFailed", async () => {
    seedActorToken();

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBe(true);
  });

  test("blocked-member unknown verdict carries resolutionFailed", async () => {
    seedContact({ id: "c1" });
    insertChannel({
      id: "ch1",
      contactId: "c1",
      address: "U_BLOCKED",
      status: "blocked",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_BLOCKED",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.status).toBe("blocked");
    expect(verdict.resolutionFailed).toBe(true);
  });

  test("intact trusted contact still classifies without a stamp", async () => {
    seedContact({ id: "c1" });
    insertChannel({ id: "ch1", contactId: "c1", address: "U_MEMBER" });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_MEMBER",
    });

    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.resolutionFailed).toBeUndefined();
  });
});

describe("healthy and fresh installs are unaffected", () => {
  test("guardian row present: stranger stays plain unknown", async () => {
    insertGuardianContact("g1");
    insertChannel({ id: "gch1", contactId: "g1", address: "U_GUARDIAN" });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBeUndefined();
  });

  test("guardian row present: guardian classifies guardian", async () => {
    insertGuardianContact("g1");
    insertChannel({ id: "gch1", contactId: "g1", address: "U_GUARDIAN" });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN",
    });

    expect(verdict.trustClass).toBe("guardian");
    expect(verdict.resolutionFailed).toBeUndefined();
  });

  test("fresh empty DB: stranger stays plain unknown", async () => {
    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBeUndefined();
  });
});

describe("integrity-check failure degrades to a plain verdict", () => {
  test("a thrown evidence read yields plain unknown, no crash", async () => {
    // Force the integrity evidence read to throw mid-check: zero contacts
    // rows sends it to the actor-token tables, which no longer exist.
    getGatewayDb().run(sql`DROP TABLE actor_token_records`);
    getGatewayDb().run(sql`DROP TABLE actor_refresh_token_records`);

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBeUndefined();
  });
});
