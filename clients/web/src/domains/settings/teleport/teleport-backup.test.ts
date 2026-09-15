import { describe, expect, it } from "bun:test";

import { hasRecentBackup, RECENT_BACKUP_MAX_AGE_MS } from "./teleport-backup";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("hasRecentBackup", () => {
  it("is true when a backup is younger than the max age", () => {
    expect(hasRecentBackup([ago(5 * 60_000)], NOW)).toBe(true);
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS)], NOW)).toBe(true);
  });

  it("is false when every backup is older than the max age", () => {
    expect(hasRecentBackup([ago(RECENT_BACKUP_MAX_AGE_MS + 1)], NOW)).toBe(
      false,
    );
    expect(hasRecentBackup([ago(2 * 24 * 60 * 60_000)], NOW)).toBe(false);
  });

  it("is false with no backups", () => {
    expect(hasRecentBackup([], NOW)).toBe(false);
  });

  it("ignores missing or unparseable timestamps", () => {
    expect(hasRecentBackup([undefined, null, "not-a-date"], NOW)).toBe(false);
    expect(hasRecentBackup([undefined, "garbage", ago(60_000)], NOW)).toBe(
      true,
    );
  });

  it("does not count timestamps from the future", () => {
    expect(hasRecentBackup([ago(-60_000)], NOW)).toBe(false);
  });

  it("finds a recent backup anywhere in the list", () => {
    expect(
      hasRecentBackup(
        [ago(3 * RECENT_BACKUP_MAX_AGE_MS), ago(30 * 60_000)],
        NOW,
      ),
    ).toBe(true);
  });

  it("honors a custom max age", () => {
    expect(hasRecentBackup([ago(10 * 60_000)], NOW, 5 * 60_000)).toBe(false);
    expect(hasRecentBackup([ago(10 * 60_000)], NOW, 15 * 60_000)).toBe(true);
  });
});
