/**
 * Tests for the skill-update receipt store: the one-open-receipt invariant,
 * entry ownership, and the revision compare-and-set that keeps an evaluation
 * from splitting a burst.
 *
 * Runs against an in-memory memory database installed through the same
 * `db-connection` stub the v3 store tests use. `mock.module` is
 * process-global and leaks into sibling files in a directory run, so the stub
 * delegates to the real implementation unless this test is actively running.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
let memoryDbAvailable = true;
let memorySqlite: Database;

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () =>
    storeMockActive
      ? memoryDbAvailable
        ? memorySqlite
        : null
      : realDb.getMemorySqlite(),
}));

const {
  countSkillUpdateReceiptEmitAttempt,
  clearAllSkillUpdateReceipts,
  hasUnsettledSkillUpdateReceipt,
  purgeSkillUpdateReceiptEntriesForConversation,
  listSealedSkillUpdateReceipts,
  listSkillUpdateReceiptEntries,
  readOpenSkillUpdateReceipt,
  recordSkillUpdate,
  sealSkillUpdateReceipt,
  settleSkillUpdateReceipt,
} = await import("../skill-update-receipt-store.js");

beforeEach(() => {
  storeMockActive = true;
  memoryDbAvailable = true;
  memorySqlite = new Database(":memory:");
});

afterAll(() => {
  storeMockActive = false;
});

function entry(id: string, skillId = "skill-a", run = "run-1") {
  return {
    entryId: id,
    skillId,
    name: skillId.toUpperCase(),
    changeSummary: `summary ${id}`,
    runConversationId: run,
  };
}

describe("recordSkillUpdate", () => {
  test("two skills from one run land on one receipt", () => {
    const first = recordSkillUpdate(entry("e1", "skill-a"), 1_000);
    const second = recordSkillUpdate(entry("e2", "skill-b"), 2_000);

    expect(first).toEqual({
      recorded: true,
      receiptId: expect.any(String),
      inserted: true,
    });
    expect(second).toMatchObject({ recorded: true, inserted: true });
    if (!first.recorded || !second.recorded) {
      throw new Error("unreachable");
    }
    expect(second.receiptId).toBe(first.receiptId);
    const open = readOpenSkillUpdateReceipt();
    expect(open).toMatchObject({
      id: first.receiptId,
      rev: 2,
      firstEntryAt: 1_000,
      lastEntryAt: 2_000,
    });
    expect(listSkillUpdateReceiptEntries(first.receiptId)).toHaveLength(2);
  });

  test("the same skill twice keeps both summaries as separate entries", () => {
    recordSkillUpdate(entry("e1", "skill-a"));
    recordSkillUpdate(entry("e2", "skill-a"));

    const open = readOpenSkillUpdateReceipt();
    const entries = listSkillUpdateReceiptEntries(open!.id);
    expect(entries.map((e) => e.changeSummary)).toEqual([
      "summary e1",
      "summary e2",
    ]);
  });

  test("a re-executed tool call records nothing and leaves the revision alone", () => {
    recordSkillUpdate(entry("e1"), 1_000);
    const again = recordSkillUpdate(
      { ...entry("e1"), changeSummary: "a different summary" },
      5_000,
    );

    expect(again).toMatchObject({ recorded: true, inserted: false });
    const open = readOpenSkillUpdateReceipt();
    expect(open).toMatchObject({ rev: 1, lastEntryAt: 1_000 });
    expect(listSkillUpdateReceiptEntries(open!.id)[0]?.changeSummary).toBe(
      "summary e1",
    );
  });

  test("an entry after the seal opens the next receipt", () => {
    recordSkillUpdate(entry("e1"));
    const first = readOpenSkillUpdateReceipt()!;
    expect(
      sealSkillUpdateReceipt({
        id: first.id,
        rev: first.rev,
        sealedBy: "quiet",
      }),
    ).toBe(true);

    recordSkillUpdate(entry("e2"));

    const second = readOpenSkillUpdateReceipt()!;
    expect(second.id).not.toBe(first.id);
    expect(listSkillUpdateReceiptEntries(first.id)).toHaveLength(1);
    expect(listSkillUpdateReceiptEntries(second.id)).toHaveLength(1);
  });

  test("a call replayed after its receipt was sealed opens nothing", () => {
    recordSkillUpdate(entry("e1"));
    const first = readOpenSkillUpdateReceipt()!;
    sealSkillUpdateReceipt({ id: first.id, rev: first.rev, sealedBy: "quiet" });

    const replay = recordSkillUpdate(entry("e1"), 9_000);

    expect(replay).toEqual({
      recorded: true,
      receiptId: first.id,
      inserted: false,
    });
    expect(readOpenSkillUpdateReceipt()).toBeNull();
  });

  test("reports rather than throws when the memory database is unavailable", () => {
    memoryDbAvailable = false;
    expect(recordSkillUpdate(entry("e1"))).toEqual({
      recorded: false,
      reason: "memory database unavailable",
    });
  });

  test("only one receipt can be open", () => {
    // The unique index is what the immediate transaction's loser relies on.
    recordSkillUpdate(entry("e1"));
    expect(() =>
      memorySqlite
        .query(
          `INSERT INTO skill_update_receipts
            (id, status, rev, first_entry_at, last_entry_at, emit_attempts)
            VALUES ('second', 'open', 0, 0, 0, 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("sealSkillUpdateReceipt", () => {
  test("an append that commits before the seal keeps the receipt open", () => {
    recordSkillUpdate(entry("e1"));
    const read = readOpenSkillUpdateReceipt()!;
    // The entry lands between the evaluation's read and its seal.
    recordSkillUpdate(entry("e2"));

    expect(
      sealSkillUpdateReceipt({ id: read.id, rev: read.rev, sealedBy: "quiet" }),
    ).toBe(false);
    expect(readOpenSkillUpdateReceipt()).toMatchObject({ id: read.id, rev: 2 });
    expect(listSealedSkillUpdateReceipts()).toHaveLength(0);
  });

  test("the cap seals whatever the receipt holds, whatever the revision", () => {
    recordSkillUpdate(entry("e1"));
    const read = readOpenSkillUpdateReceipt()!;
    recordSkillUpdate(entry("e2"));

    expect(
      sealSkillUpdateReceipt({ id: read.id, rev: null, sealedBy: "cap" }),
    ).toBe(true);
    expect(readOpenSkillUpdateReceipt()).toBeNull();
    expect(listSealedSkillUpdateReceipts()).toMatchObject([
      { id: read.id, sealedBy: "cap" },
    ]);
    expect(listSkillUpdateReceiptEntries(read.id)).toHaveLength(2);
  });

  test("every entry belongs to exactly one receipt across a seal race", () => {
    // Interleave appends and seals and check the partition at the end.
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      recordSkillUpdate(entry(`e${i}`, `skill-${i % 3}`));
      ids.push(`e${i}`);
      if (i % 4 === 3) {
        const open = readOpenSkillUpdateReceipt()!;
        recordSkillUpdate(entry(`late-${i}`));
        ids.push(`late-${i}`);
        // Loses to the late append, so the receipt stays open with it.
        expect(
          sealSkillUpdateReceipt({
            id: open.id,
            rev: open.rev,
            sealedBy: "quiet",
          }),
        ).toBe(false);
        const reread = readOpenSkillUpdateReceipt()!;
        expect(
          sealSkillUpdateReceipt({
            id: reread.id,
            rev: reread.rev,
            sealedBy: "quiet",
          }),
        ).toBe(true);
      }
    }
    const receipts = memorySqlite
      .query(`SELECT id FROM skill_update_receipts`)
      .all() as Array<{ id: string }>;
    const seen = new Map<string, string>();
    for (const receipt of receipts) {
      for (const e of listSkillUpdateReceiptEntries(receipt.id)) {
        expect(seen.has(e.entryId)).toBe(false);
        seen.set(e.entryId, receipt.id);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...ids].sort());
  });
});

describe("lifecycle", () => {
  test("a sealed receipt counts attempts and settles once", () => {
    recordSkillUpdate(entry("e1"));
    const open = readOpenSkillUpdateReceipt()!;
    sealSkillUpdateReceipt({ id: open.id, rev: open.rev, sealedBy: "quiet" });
    expect(hasUnsettledSkillUpdateReceipt()).toBe(true);

    expect(countSkillUpdateReceiptEmitAttempt(open.id)).toBe(1);
    expect(countSkillUpdateReceiptEmitAttempt(open.id)).toBe(2);
    settleSkillUpdateReceipt({ id: open.id, status: "delivered" });

    expect(listSealedSkillUpdateReceipts()).toHaveLength(0);
    expect(hasUnsettledSkillUpdateReceipt()).toBe(false);
    // A settled receipt is terminal: another settle and another count are
    // no-ops.
    settleSkillUpdateReceipt({ id: open.id, status: "undelivered" });
    expect(countSkillUpdateReceiptEmitAttempt(open.id)).toBe(2);
    const row = memorySqlite
      .query(`SELECT status FROM skill_update_receipts WHERE id = ?`)
      .get(open.id) as { status: string };
    expect(row.status).toBe("delivered");
  });
});

describe("conversation purge", () => {
  test("drops a deleted conversation's entries, as source or as run, and any receipt left empty", () => {
    recordSkillUpdate({
      ...entry("e1", "skill-a", "run-1"),
      sourceConversationId: "conv-gone",
    });
    recordSkillUpdate(entry("e2", "skill-b", "run-gone"));
    recordSkillUpdate({
      ...entry("e3", "skill-c", "run-2"),
      sourceConversationId: "conv-kept",
    });
    const open = readOpenSkillUpdateReceipt()!;

    purgeSkillUpdateReceiptEntriesForConversation("conv-gone");
    purgeSkillUpdateReceiptEntriesForConversation("run-gone");

    expect(
      listSkillUpdateReceiptEntries(open.id).map((e) => e.entryId),
    ).toEqual(["e3"]);
    expect(readOpenSkillUpdateReceipt()?.id).toBe(open.id);

    purgeSkillUpdateReceiptEntriesForConversation("conv-kept");

    expect(readOpenSkillUpdateReceipt()).toBeNull();
    expect(hasUnsettledSkillUpdateReceipt()).toBe(false);
  });

  test("clear-all drops every receipt and entry", () => {
    recordSkillUpdate(entry("e1"));
    const open = readOpenSkillUpdateReceipt()!;
    sealSkillUpdateReceipt({ id: open.id, rev: open.rev, sealedBy: "quiet" });
    recordSkillUpdate(entry("e2"));

    clearAllSkillUpdateReceipts();

    expect(hasUnsettledSkillUpdateReceipt()).toBe(false);
    expect(listSkillUpdateReceiptEntries(open.id)).toEqual([]);
  });
});
