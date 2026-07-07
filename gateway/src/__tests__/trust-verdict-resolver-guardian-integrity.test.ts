/**
 * Guardian-integrity stamping in the trust-verdict resolver:
 *
 *  - Onboarded-evidence DB with zero guardian rows → every `unknown`
 *    classification carries `resolutionFailed: true` (consumers fail closed).
 *  - Non-unknown classifications (e.g. an intact trusted contact) are never
 *    stamped by the integrity check, but they still evaluate the state — the
 *    fail-loud reporter fires on member traffic too, not just strangers.
 *  - Fresh install and healthy (guardian present) install → verdicts
 *    unchanged, no `resolutionFailed`.
 *  - A thrown integrity check degrades to the plain unknown verdict — no
 *    crash, no stamp.
 *
 * The fail-loud reporter is silenced/observed through its test-only overrides
 * so no relay or log leaves the test process (bun's mock.module is
 * process-global and would leak into other test files).
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

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
const {
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} = await import("../guardian-integrity-reporter.js");
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

// Captured reporter detail payloads (via the log-override seam).
const reportCalls: Record<string, unknown>[] = [];

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  getGatewayDb().delete(actorTokenRecords).run();
  getGatewayDb().delete(actorRefreshTokenRecords).run();
  bustGuardianIntegrityCache();
  reportCalls.length = 0;
  resetGuardianIntegrityReporterForTesting();
  setGuardianIntegrityReporterOverridesForTesting({
    fetchImpl: async () => new Response("{}"),
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: {
      error: (detail) => {
        reportCalls.push(detail);
      },
      warn: () => {},
    },
  });
});

afterEach(() => {
  resetGatewayDb();
  resetGuardianIntegrityReporterForTesting();
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

  test("intact trusted contact classifies without a stamp but fires the reporter", async () => {
    seedContact({ id: "c1" });
    insertChannel({ id: "ch1", contactId: "c1", address: "U_MEMBER" });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_MEMBER",
    });

    // Member admission is unchanged — no resolutionFailed on the verdict —
    // but detection is traffic-independent: member traffic alone reports.
    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.resolutionFailed).toBeUndefined();
    expect(reportCalls).toEqual([
      { has_contacts: true, has_actor_tokens: false },
    ]);
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
    expect(reportCalls).toHaveLength(0);
  });

  test("fresh empty DB: stranger stays plain unknown", async () => {
    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBeUndefined();
    expect(reportCalls).toHaveLength(0);
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
