import { describe, expect, test } from "bun:test";

import {
  hasRecentBackup,
  managedBackupIsReady,
  readyManagedBackupCreatedAts,
  RECENT_BACKUP_MAX_AGE_MS,
} from "./teleport-backup-policy";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("hasRecentBackup", () => {
  test("true when a backup is within the max age", () => {
    expect(hasRecentBackup([ago(5 * 60_000)], NOW)).toBe(true);
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS)], NOW)).toBe(true);
  });

  test("false when every backup is older than the max age", () => {
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS + 1)], NOW)).toBe(
      false,
    );
    expect(hasRecentBackup([ago(2 * 24 * 60 * 60_000)], NOW)).toBe(false);
  });

  test("false with no backups", () => {
    expect(hasRecentBackup([], NOW)).toBe(false);
  });

  test("ignores empty, missing, unparseable and future timestamps", () => {
    expect(
      hasRecentBackup(["", undefined, null, "garbage", ago(-60_000)], NOW),
    ).toBe(false);
    expect(hasRecentBackup(["", "garbage", ago(60_000)], NOW)).toBe(true);
  });

  test("finds a recent backup anywhere in the list", () => {
    expect(
      hasRecentBackup(
        [ago(3 * RECENT_BACKUP_MAX_AGE_MS), ago(30 * 60_000)],
        NOW,
      ),
    ).toBe(true);
  });

  test("honors a custom max age", () => {
    expect(hasRecentBackup([ago(10 * 60_000)], NOW, 5 * 60_000)).toBe(false);
    expect(hasRecentBackup([ago(10 * 60_000)], NOW, 15 * 60_000)).toBe(true);
  });
});

describe("readyManagedBackupCreatedAts", () => {
  test("keeps ready snapshots and drops pending ones", () => {
    expect(
      readyManagedBackupCreatedAts([
        {
          snapshot_name: "a",
          created_at: "2026-09-15T11:00:00Z",
          ready_to_use: true,
        },
        {
          snapshot_name: "b",
          created_at: "2026-09-15T11:30:00Z",
          ready_to_use: false,
        },
        { snapshot_name: "c", created_at: "2026-09-15T10:00:00Z" },
      ]),
    ).toEqual(["2026-09-15T11:00:00Z", "2026-09-15T10:00:00Z"]);
  });
});

describe("managedBackupIsReady", () => {
  const backups = [
    { snapshot_name: "ready", ready_to_use: true },
    { snapshot_name: "pending", ready_to_use: false },
    { snapshot_name: "unknown" },
  ];

  test("true only for a snapshot explicitly marked ready", () => {
    expect(managedBackupIsReady(backups, "ready")).toBe(true);
    expect(managedBackupIsReady(backups, "pending")).toBe(false);
    expect(managedBackupIsReady(backups, "unknown")).toBe(false);
    expect(managedBackupIsReady(backups, "missing")).toBe(false);
  });
});
