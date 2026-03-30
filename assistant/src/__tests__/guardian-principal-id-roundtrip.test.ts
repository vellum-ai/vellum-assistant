import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  resolveCanonicalGuardianRequest,
  updateCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

describe("guardianPrincipalId roundtrip", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
  });

  // ── canonical_guardian_requests ──────────────────────────────────────

  describe("canonical_guardian_requests", () => {
    test("creates request with guardianPrincipalId and reads it back", () => {
      const req = createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "channel",
        sourceChannel: "telegram",
        guardianExternalUserId: "guardian-tg-1",
        guardianPrincipalId: "principal-123",
      });

      expect(req.guardianPrincipalId).toBe("principal-123");
      expect(req.decidedByPrincipalId).toBeNull();

      const fetched = getCanonicalGuardianRequest(req.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.guardianPrincipalId).toBe("principal-123");
      expect(fetched!.decidedByPrincipalId).toBeNull();
    });

    test("access_request requires guardianPrincipalId (decisionable kind)", () => {
      // access_request is now decisionable — creating one without a principal
      // should throw IntegrityError.
      expect(() =>
        createCanonicalGuardianRequest({
          kind: "access_request",
          sourceType: "desktop",
        }),
      ).toThrow("guardianPrincipalId");

      // With a principal, creation succeeds
      const req = createCanonicalGuardianRequest({
        kind: "access_request",
        sourceType: "desktop",
        guardianPrincipalId: "access-req-principal",
      });
      expect(req.guardianPrincipalId).toBe("access-req-principal");
      expect(req.decidedByPrincipalId).toBeNull();
    });

    test("creates request with decidedByPrincipalId", () => {
      const req = createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "voice",
        guardianPrincipalId: "guardian-principal-1",
        decidedByPrincipalId: "decider-principal-1",
      });

      expect(req.decidedByPrincipalId).toBe("decider-principal-1");
      expect(req.guardianPrincipalId).toBe("guardian-principal-1");
    });

    test("updates decidedByPrincipalId via updateCanonicalGuardianRequest", () => {
      const req = createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "channel",
        guardianPrincipalId: "principal-for-update-test",
      });

      const updated = updateCanonicalGuardianRequest(req.id, {
        status: "approved",
        decidedByPrincipalId: "principal-decider-abc",
        decidedByExternalUserId: "ext-user-1",
      });

      expect(updated).not.toBeNull();
      expect(updated!.decidedByPrincipalId).toBe("principal-decider-abc");
      expect(updated!.decidedByExternalUserId).toBe("ext-user-1");
      expect(updated!.status).toBe("approved");
    });

    test("resolveCanonicalGuardianRequest writes decidedByPrincipalId", () => {
      const req = createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "voice",
        guardianPrincipalId: "guardian-principal-xyz",
      });

      const resolved = resolveCanonicalGuardianRequest(req.id, "pending", {
        status: "approved",
        answerText: "Approved",
        decidedByExternalUserId: "guardian-ext-1",
        decidedByPrincipalId: "guardian-principal-xyz",
      });

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("approved");
      expect(resolved!.decidedByPrincipalId).toBe("guardian-principal-xyz");
      expect(resolved!.decidedByExternalUserId).toBe("guardian-ext-1");
      expect(resolved!.guardianPrincipalId).toBe("guardian-principal-xyz");
    });

    test("resolve without decidedByPrincipalId leaves it null", () => {
      const req = createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "channel",
        guardianPrincipalId: "principal-for-resolve-test",
      });

      const resolved = resolveCanonicalGuardianRequest(req.id, "pending", {
        status: "denied",
        decidedByExternalUserId: "guardian-ext-2",
      });

      expect(resolved).not.toBeNull();
      expect(resolved!.decidedByPrincipalId).toBeNull();
    });
  });
});
