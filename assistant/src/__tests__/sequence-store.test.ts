import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "sequence-store-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { sequenceEnrollments, sequences } from "../memory/schema.js";
import {
  advanceEnrollment,
  claimDueEnrollments,
  countActiveEnrollments,
  createSequence,
  deleteSequence,
  enrollContact,
  exitEnrollment,
  findActiveEnrollmentsByEmail,
  getEnrollment,
  getSequence,
  listEnrollments,
  listSequences,
  updateSequence,
} from "../sequence/store.js";
import type { SequenceStep } from "../sequence/types.js";

initializeDb();

function clearTables() {
  const db = getDb();
  db.delete(sequenceEnrollments).run();
  db.delete(sequences).run();
}

const testSteps: SequenceStep[] = [
  {
    index: 0,
    delaySeconds: 0,
    subjectTemplate: "Intro",
    bodyPrompt: "Write an intro email",
    replyToThread: false,
    requireApproval: false,
  },
  {
    index: 1,
    delaySeconds: 86400,
    subjectTemplate: "Follow up",
    bodyPrompt: "Write a follow-up",
    replyToThread: true,
    requireApproval: false,
  },
  {
    index: 2,
    delaySeconds: 259200,
    subjectTemplate: "Final check",
    bodyPrompt: "Write a final check-in",
    replyToThread: true,
    requireApproval: true,
  },
];

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("sequence-store", () => {
  beforeEach(() => {
    clearTables();
  });

  // ── Sequence CRUD ───────────────────────────────────────────────

  describe("createSequence", () => {
    test("creates a sequence with correct fields", () => {
      const seq = createSequence({
        name: "Investor outreach",
        description: "Reach out to investors",
        channel: "gmail",
        steps: testSteps,
      });

      expect(seq.id).toBeTruthy();
      expect(seq.name).toBe("Investor outreach");
      expect(seq.description).toBe("Reach out to investors");
      expect(seq.channel).toBe("gmail");
      expect(seq.steps).toHaveLength(3);
      expect(seq.steps[0].subjectTemplate).toBe("Intro");
      expect(seq.exitOnReply).toBe(true);
      expect(seq.status).toBe("active");
    });

    test("defaults exitOnReply to true", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      expect(seq.exitOnReply).toBe(true);
    });

    test("allows overriding exitOnReply", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
        exitOnReply: false,
      });
      expect(seq.exitOnReply).toBe(false);
    });
  });

  describe("getSequence", () => {
    test("returns sequence by id", () => {
      const created = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const fetched = getSequence(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Test");
      expect(fetched!.steps).toHaveLength(3);
    });

    test("returns undefined for non-existent id", () => {
      expect(getSequence("non-existent")).toBeUndefined();
    });
  });

  describe("listSequences", () => {
    test("lists all sequences", () => {
      createSequence({ name: "A", channel: "gmail", steps: testSteps });
      createSequence({ name: "B", channel: "agentmail", steps: testSteps });
      expect(listSequences()).toHaveLength(2);
    });

    test("filters by status", () => {
      createSequence({ name: "Active", channel: "gmail", steps: testSteps });
      const paused = createSequence({
        name: "Paused",
        channel: "gmail",
        steps: testSteps,
      });
      updateSequence(paused.id, { status: "paused" });

      expect(listSequences({ status: "active" })).toHaveLength(1);
      expect(listSequences({ status: "paused" })).toHaveLength(1);
    });
  });

  describe("updateSequence", () => {
    test("updates name and description", () => {
      const seq = createSequence({
        name: "Old",
        channel: "gmail",
        steps: testSteps,
      });
      const updated = updateSequence(seq.id, {
        name: "New",
        description: "Updated",
      });
      expect(updated!.name).toBe("New");
      expect(updated!.description).toBe("Updated");
    });

    test("updates status", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const updated = updateSequence(seq.id, { status: "paused" });
      expect(updated!.status).toBe("paused");
    });

    test("updates steps", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const newSteps = [testSteps[0]];
      const updated = updateSequence(seq.id, { steps: newSteps });
      expect(updated!.steps).toHaveLength(1);
    });
  });

  describe("deleteSequence", () => {
    test("deletes sequence and cancels active enrollments", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });
      enrollContact({ sequenceId: seq.id, contactEmail: "b@test.com" });

      deleteSequence(seq.id);

      expect(getSequence(seq.id)).toBeUndefined();
      // Enrollments should have been cascade-deleted
      expect(listEnrollments({ sequenceId: seq.id })).toHaveLength(0);
    });
  });

  // ── Enrollment CRUD ─────────────────────────────────────────────

  describe("enrollContact", () => {
    test("creates enrollment with correct fields", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = enrollContact({
        sequenceId: seq.id,
        contactEmail: "investor@example.com",
        contactName: "Jane Doe",
        context: { company: "Acme Corp" },
      });

      expect(enrollment.id).toBeTruthy();
      expect(enrollment.sequenceId).toBe(seq.id);
      expect(enrollment.contactEmail).toBe("investor@example.com");
      expect(enrollment.contactName).toBe("Jane Doe");
      expect(enrollment.currentStep).toBe(0);
      expect(enrollment.status).toBe("active");
      expect(enrollment.nextStepAt).toBeTruthy();
      expect(enrollment.context).toEqual({ company: "Acme Corp" });
    });

    test("computes nextStepAt from first step delay", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const before = Date.now();
      const enrollment = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });
      const after = Date.now();

      // First step has delaySeconds: 0, so nextStepAt should be ~now
      expect(enrollment.nextStepAt).toBeGreaterThanOrEqual(before);
      expect(enrollment.nextStepAt).toBeLessThanOrEqual(after + 1);
    });

    test("throws for non-existent sequence", () => {
      expect(() =>
        enrollContact({ sequenceId: "fake", contactEmail: "a@test.com" }),
      ).toThrow("Sequence not found");
    });

    test("throws for sequence with no steps", () => {
      const seq = createSequence({
        name: "Empty",
        channel: "gmail",
        steps: [],
      });
      // Steps are empty but stored as []
      expect(() =>
        enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" }),
      ).toThrow("Sequence has no steps");
    });
  });

  describe("listEnrollments", () => {
    test("filters by sequenceId", () => {
      const s1 = createSequence({
        name: "S1",
        channel: "gmail",
        steps: testSteps,
      });
      const s2 = createSequence({
        name: "S2",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: s1.id, contactEmail: "a@test.com" });
      enrollContact({ sequenceId: s2.id, contactEmail: "b@test.com" });

      expect(listEnrollments({ sequenceId: s1.id })).toHaveLength(1);
      expect(listEnrollments({ sequenceId: s2.id })).toHaveLength(1);
    });

    test("filters by status", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const e1 = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "b@test.com" });
      exitEnrollment(e1.id, "completed");

      expect(listEnrollments({ status: "active" })).toHaveLength(1);
      expect(listEnrollments({ status: "completed" })).toHaveLength(1);
    });

    test("filters by contactEmail", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });
      enrollContact({ sequenceId: seq.id, contactEmail: "b@test.com" });

      expect(listEnrollments({ contactEmail: "a@test.com" })).toHaveLength(1);
    });
  });

  // ── Claim & Advance ─────────────────────────────────────────────

  describe("claimDueEnrollments", () => {
    test("claims enrollments with nextStepAt <= now", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });

      // The first step has delay 0, so nextStepAt is ~now
      const claimed = claimDueEnrollments(Date.now() + 1000);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].contactEmail).toBe("a@test.com");
    });

    test("does not claim enrollments not yet due", () => {
      const futureSteps: SequenceStep[] = [
        {
          index: 0,
          delaySeconds: 86400,
          subjectTemplate: "Future",
          bodyPrompt: "Later",
          replyToThread: false,
          requireApproval: false,
        },
      ];
      const seq = createSequence({
        name: "Future",
        channel: "gmail",
        steps: futureSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });

      const claimed = claimDueEnrollments(Date.now());
      expect(claimed).toHaveLength(0);
    });

    test("optimistic locking prevents double-claiming", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });

      const now = Date.now() + 1000;
      const first = claimDueEnrollments(now);
      const second = claimDueEnrollments(now);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    test("respects limit parameter", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });
      enrollContact({ sequenceId: seq.id, contactEmail: "b@test.com" });
      enrollContact({ sequenceId: seq.id, contactEmail: "c@test.com" });

      const claimed = claimDueEnrollments(Date.now() + 1000, 2);
      expect(claimed).toHaveLength(2);
    });

    test("does not claim paused enrollments", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });
      exitEnrollment(enrollment.id, "cancelled");

      const claimed = claimDueEnrollments(Date.now() + 1000);
      expect(claimed).toHaveLength(0);
    });
  });

  describe("advanceEnrollment", () => {
    test("increments currentStep", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });

      const advanced = advanceEnrollment(
        enrollment.id,
        "thread-123",
        Date.now() + 86400000,
      );
      expect(advanced!.currentStep).toBe(1);
      expect(advanced!.threadId).toBe("thread-123");
    });

    test("returns undefined for non-existent id", () => {
      expect(advanceEnrollment("fake")).toBeUndefined();
    });
  });

  describe("exitEnrollment", () => {
    test("sets status and clears nextStepAt", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });

      exitEnrollment(enrollment.id, "replied");

      const updated = getEnrollment(enrollment.id);
      expect(updated!.status).toBe("replied");
      expect(updated!.nextStepAt).toBeNull();
    });

    test.each(["completed", "replied", "cancelled", "failed"] as const)(
      "supports exit reason: %s",
      (reason) => {
        const seq = createSequence({
          name: "Test",
          channel: "gmail",
          steps: testSteps,
        });
        const enrollment = enrollContact({
          sequenceId: seq.id,
          contactEmail: `${reason}@test.com`,
        });

        exitEnrollment(enrollment.id, reason);

        const updated = getEnrollment(enrollment.id);
        expect(updated!.status).toBe(reason);
      },
    );
  });

  // ── Query Helpers ───────────────────────────────────────────────

  describe("findActiveEnrollmentsByEmail", () => {
    test("finds active enrollments for an email", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });
      const e2 = enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@test.com",
      });
      exitEnrollment(e2.id, "completed");

      const active = findActiveEnrollmentsByEmail("a@test.com");
      expect(active).toHaveLength(1);
    });

    test("returns empty for unknown email", () => {
      expect(findActiveEnrollmentsByEmail("unknown@test.com")).toHaveLength(0);
    });
  });

  describe("countActiveEnrollments", () => {
    test("counts only active enrollments for a sequence", () => {
      const seq = createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      enrollContact({ sequenceId: seq.id, contactEmail: "a@test.com" });
      enrollContact({ sequenceId: seq.id, contactEmail: "b@test.com" });
      const e3 = enrollContact({
        sequenceId: seq.id,
        contactEmail: "c@test.com",
      });
      exitEnrollment(e3.id, "completed");

      expect(countActiveEnrollments(seq.id)).toBe(2);
    });
  });
});
