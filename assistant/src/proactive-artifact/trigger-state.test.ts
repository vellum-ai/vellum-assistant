import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../memory/db-init.js";
import { rawRun } from "../memory/raw-query.js";
import { getDataDir } from "../util/platform.js";

initializeDb();

import {
  backfillGuardIfNeeded,
  getUserMessageCountUpTo,
  hasProactiveArtifactCompleted,
  releaseProactiveArtifactClaim,
  tryClaimProactiveArtifactTrigger,
} from "./trigger-state.js";

let seedId = 0;

function guardPath(): string {
  return join(getDataDir(), ".proactive-artifact-completed");
}

function seedUserMessage(createdAt: number): void {
  const id = ++seedId;
  const convId = `test-conv-${id}`;
  rawRun(
    `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source)
     VALUES (?, ?, ?, ?, 'standard', 'user')`,
    convId,
    `Test ${id}`,
    createdAt,
    createdAt,
  );
  rawRun(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', 'hello', ?)`,
    `test-msg-${id}`,
    convId,
    createdAt,
  );
}

function removeGuard(): void {
  try {
    rmSync(guardPath(), { force: true });
  } catch {
    /* ignore */
  }
}

describe("trigger-state", () => {
  beforeEach(() => {
    rawRun("DELETE FROM messages");
    rawRun("DELETE FROM conversations");
    removeGuard();
    seedId = 0;
  });

  describe("getUserMessageCountUpTo", () => {
    test("returns 0 when no messages exist", () => {
      expect(getUserMessageCountUpTo(Date.now())).toBe(0);
    });

    test("counts only user messages in standard conversations", () => {
      const now = 1000;
      seedUserMessage(now);
      seedUserMessage(now + 1);

      // Insert a non-user message
      const convId = "non-user-conv";
      rawRun(
        `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source)
         VALUES (?, ?, ?, ?, 'standard', 'user')`,
        convId,
        "Non-user",
        now + 2,
        now + 2,
      );
      rawRun(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES (?, ?, 'assistant', 'hi', ?)`,
        "assistant-msg",
        convId,
        now + 2,
      );

      // Insert a user message in a non-standard conversation
      const bgConvId = "bg-conv";
      rawRun(
        `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source)
         VALUES (?, ?, ?, ?, 'background', 'user')`,
        bgConvId,
        "Background",
        now + 3,
        now + 3,
      );
      rawRun(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES (?, ?, 'user', 'hello', ?)`,
        "bg-msg",
        bgConvId,
        now + 3,
      );

      expect(getUserMessageCountUpTo(now + 10)).toBe(2);
    });

    test("respects beforeOrAt filter", () => {
      seedUserMessage(100);
      seedUserMessage(200);
      seedUserMessage(300);

      expect(getUserMessageCountUpTo(150)).toBe(1);
      expect(getUserMessageCountUpTo(250)).toBe(2);
      expect(getUserMessageCountUpTo(350)).toBe(3);
    });

    test("caps at 11 due to LIMIT", () => {
      for (let i = 1; i <= 15; i++) {
        seedUserMessage(i * 100);
      }
      expect(getUserMessageCountUpTo(Date.now())).toBe(11);
    });
  });

  describe("tryClaimProactiveArtifactTrigger", () => {
    test("returns false at count 1, 2, 3 and does NOT write guard", () => {
      seedUserMessage(100);
      expect(tryClaimProactiveArtifactTrigger(100)).toBe(false);
      expect(existsSync(guardPath())).toBe(false);

      seedUserMessage(200);
      expect(tryClaimProactiveArtifactTrigger(200)).toBe(false);
      expect(existsSync(guardPath())).toBe(false);

      seedUserMessage(300);
      expect(tryClaimProactiveArtifactTrigger(300)).toBe(false);
      expect(existsSync(guardPath())).toBe(false);
    });

    test("returns true at count 4 (start of window) and writes guard", () => {
      for (let i = 1; i <= 4; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(400)).toBe(true);
      expect(existsSync(guardPath())).toBe(true);
    });

    test("returns true at count 10 (end of window) and writes guard", () => {
      for (let i = 1; i <= 10; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(1000)).toBe(true);
      expect(existsSync(guardPath())).toBe(true);
    });

    test("returns true at count 7 (mid-window) and writes guard", () => {
      for (let i = 1; i <= 7; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(700)).toBe(true);
      expect(existsSync(guardPath())).toBe(true);
    });

    test("returns false on second call (EEXIST from wx)", () => {
      for (let i = 1; i <= 4; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(400)).toBe(true);
      expect(tryClaimProactiveArtifactTrigger(400)).toBe(false);
    });

    test("returns false at count > 10 and writes guard permanently", () => {
      for (let i = 1; i <= 11; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(1100)).toBe(false);
      expect(existsSync(guardPath())).toBe(true);
    });

    test("concurrent calls: only one returns true", () => {
      for (let i = 1; i <= 4; i++) seedUserMessage(i * 100);

      const results = [
        tryClaimProactiveArtifactTrigger(400),
        tryClaimProactiveArtifactTrigger(400),
        tryClaimProactiveArtifactTrigger(400),
      ];

      expect(results.filter((r) => r === true)).toHaveLength(1);
      expect(results.filter((r) => r === false)).toHaveLength(2);
    });

    test("rapid next-message race: in-window trigger still fires", () => {
      for (let i = 1; i <= 5; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(400)).toBe(true);
    });
  });

  describe("releaseProactiveArtifactClaim", () => {
    test("removes guard file so next turn can retry", () => {
      for (let i = 1; i <= 4; i++) seedUserMessage(i * 100);

      expect(tryClaimProactiveArtifactTrigger(400)).toBe(true);
      expect(existsSync(guardPath())).toBe(true);

      releaseProactiveArtifactClaim();
      expect(existsSync(guardPath())).toBe(false);

      seedUserMessage(500);
      expect(tryClaimProactiveArtifactTrigger(500)).toBe(true);
      expect(existsSync(guardPath())).toBe(true);
    });

    test("is no-op when guard does not exist", () => {
      expect(existsSync(guardPath())).toBe(false);
      releaseProactiveArtifactClaim();
      expect(existsSync(guardPath())).toBe(false);
    });
  });

  describe("hasProactiveArtifactCompleted", () => {
    test("returns false when guard does not exist", () => {
      expect(hasProactiveArtifactCompleted()).toBe(false);
    });

    test("returns true when guard exists", () => {
      mkdirSync(join(getDataDir()), { recursive: true });
      writeFileSync(guardPath(), new Date().toISOString());
      expect(hasProactiveArtifactCompleted()).toBe(true);
    });
  });

  describe("backfillGuardIfNeeded", () => {
    test("creates guard when count > 10", () => {
      for (let i = 1; i <= 11; i++) {
        seedUserMessage(i * 100);
      }

      backfillGuardIfNeeded();
      expect(existsSync(guardPath())).toBe(true);
    });

    test("is no-op when count is within window (4-10)", () => {
      for (let i = 1; i <= 7; i++) {
        seedUserMessage(i * 100);
      }

      backfillGuardIfNeeded();
      expect(existsSync(guardPath())).toBe(false);
    });

    test("is no-op when count < 4", () => {
      seedUserMessage(100);
      seedUserMessage(200);
      seedUserMessage(300);

      backfillGuardIfNeeded();
      expect(existsSync(guardPath())).toBe(false);
    });

    test("is no-op when guard already exists", () => {
      for (let i = 1; i <= 11; i++) {
        seedUserMessage(i * 100);
      }

      mkdirSync(join(getDataDir()), { recursive: true });
      writeFileSync(guardPath(), "already-exists");
      backfillGuardIfNeeded();
      expect(readFileSync(guardPath(), "utf-8")).toBe("already-exists");
    });
  });
});
