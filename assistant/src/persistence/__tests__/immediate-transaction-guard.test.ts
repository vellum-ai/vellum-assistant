import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";

// Guard for the driver contract `forkConversationForRetrospective`'s phase-3
// transaction relies on: drizzle's bun-sqlite driver must map
// `db.transaction(cb, { behavior: "immediate" })` onto BEGIN IMMEDIATE, i.e.
// acquire the write lock at BEGIN rather than at the first write. If a
// drizzle upgrade silently dropped the behavior config, the phase-3
// SQLITE_BUSY_SNAPSHOT fix would regress to a deferred read→write upgrade.
test("bun-sqlite drizzle transaction honors behavior: 'immediate'", () => {
  const dbPath = join(tmpdir(), `immediate-txn-guard-${Date.now()}.db`);
  const writer = new Database(dbPath);
  const probe = new Database(dbPath);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("CREATE TABLE t (x INTEGER)");
    // Fail immediately instead of waiting when the write lock is taken.
    probe.exec("PRAGMA busy_timeout=0");
    const probeDb = drizzle(probe);

    writer.exec("BEGIN IMMEDIATE");
    try {
      // A DEFERRED empty transaction acquires no locks, so it succeeds even
      // while the writer holds the write lock — the baseline that proves the
      // failure below comes from the behavior config, not the environment.
      const ran: string[] = [];
      probeDb.transaction(() => {
        ran.push("deferred");
      });
      expect(ran).toEqual(["deferred"]);

      // An IMMEDIATE transaction must take the write lock at BEGIN and fail
      // fast (busy_timeout=0) while the writer holds it.
      expect(() =>
        probeDb.transaction(
          () => {
            /* never reached: BEGIN IMMEDIATE itself must throw */
          },
          { behavior: "immediate" },
        ),
      ).toThrow(/SQLITE_BUSY|database is locked/i);
    } finally {
      writer.exec("COMMIT");
    }

    // With the write lock free, the immediate transaction runs normally.
    const value = probeDb.transaction(
      () => {
        probe.exec("INSERT INTO t (x) VALUES (1)");
        return "committed";
      },
      { behavior: "immediate" },
    );
    expect(value).toBe("committed");
  } finally {
    writer.close();
    probe.close();
    assertNotLiveDb(dbPath);
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});
