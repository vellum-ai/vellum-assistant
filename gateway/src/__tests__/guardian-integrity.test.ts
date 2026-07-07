/**
 * Guardian-row integrity detection (auth/guardian-integrity.ts):
 *
 *  - Fresh empty DB → no evidence, state "ok", no report.
 *  - Zero guardian rows + evidence (contacts rows, or actor/refresh token
 *    rows) → "missing_guardian" and the reporter fires with the signals.
 *  - Guardian row present → "ok" regardless of evidence.
 *  - State is TTL-cached; bustGuardianIntegrityCache() forces a recompute.
 *
 * The reporter is silenced and observed through its test-only overrides
 * (bun's mock.module is process-global and would leak into other test
 * files); its logging/relay behavior has its own tests
 * (guardian-integrity-reporter.test.ts).
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";

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
const {
  bustGuardianIntegrityCache,
  guardianIntegrityState,
  hasEvidenceOfPriorGuardian,
} = await import("../auth/guardian-integrity.js");

// The reporter's first-report error log carries the detail payload; capture
// it as the "reported" signal.
const reportCalls: Record<string, unknown>[] = [];

function insertRefreshToken(): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: `refresh-${now}`,
      tokenHash: "hash-2",
      familyId: "family-1",
      guardianPrincipalId: "principal-123",
      hashedDeviceId: "device-abc",
      platform: "macos",
      status: "active",
      issuedAt: now,
      absoluteExpiresAt: now + 1000,
      inactivityExpiresAt: now + 1000,
      createdAt: now,
      updatedAt: now,
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

describe("hasEvidenceOfPriorGuardian", () => {
  test("fresh empty DB has no evidence", () => {
    expect(hasEvidenceOfPriorGuardian()).toBe(false);
  });

  test("any contacts row is evidence", () => {
    seedContact({ id: "c1" });
    expect(hasEvidenceOfPriorGuardian()).toBe(true);
  });

  test("any actor token row is evidence", () => {
    seedActorToken();
    expect(hasEvidenceOfPriorGuardian()).toBe(true);
  });

  test("any refresh token row is evidence", () => {
    insertRefreshToken();
    expect(hasEvidenceOfPriorGuardian()).toBe(true);
  });
});

describe("guardianIntegrityState", () => {
  test("fresh empty DB is ok and does not report", () => {
    expect(guardianIntegrityState()).toBe("ok");
    expect(reportCalls.length).toBe(0);
  });

  test("guardian row present is ok even with token evidence", () => {
    seedContact({ id: "g1", role: "guardian" });
    seedActorToken();
    expect(guardianIntegrityState()).toBe("ok");
    expect(reportCalls.length).toBe(0);
  });

  test("zero guardian rows + non-guardian contact is missing_guardian and reports", () => {
    seedContact({ id: "c1" });
    expect(guardianIntegrityState()).toBe("missing_guardian");
    expect(reportCalls).toEqual([
      { has_contacts: true, has_actor_tokens: false },
    ]);
  });

  test("zero guardian rows + actor token evidence is missing_guardian", () => {
    seedActorToken();
    expect(guardianIntegrityState()).toBe("missing_guardian");
    expect(reportCalls).toEqual([
      { has_contacts: false, has_actor_tokens: true },
    ]);
  });

  test("state is cached until bustGuardianIntegrityCache()", () => {
    seedActorToken();
    expect(guardianIntegrityState()).toBe("missing_guardian");

    // Re-seed the guardian; the cached state still answers within the TTL.
    seedContact({ id: "g1", role: "guardian" });
    expect(guardianIntegrityState()).toBe("missing_guardian");

    bustGuardianIntegrityCache();
    expect(guardianIntegrityState()).toBe("ok");
  });
});
