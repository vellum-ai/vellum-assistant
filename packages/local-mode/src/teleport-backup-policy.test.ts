import { describe, expect, test } from "bun:test";

import {
  hasRecentBackup,
  managedBackupIsReady,
  PIN_LABEL_RE,
  pinLabelForAssistant,
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

describe("pinLabelForAssistant", () => {
  test("uses a safe id verbatim", async () => {
    expect(await pinLabelForAssistant("ast-1")).toBe("ast-1");
    expect(
      await pinLabelForAssistant("11111111-2222-3333-4444-555555555555"),
    ).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("sanitizes ids with spaces or Unicode and appends a hash", async () => {
    const label = await pinLabelForAssistant("My Assistant \u00e9");
    expect(label).toMatch(PIN_LABEL_RE);
    expect(label.startsWith("My_Assistant_-")).toBe(true);
    expect(label).toMatch(/-[0-9a-f]{16}$/);
  });

  test("truncates over-long ids and keeps the result within the grammar", async () => {
    const label = await pinLabelForAssistant("a".repeat(300));
    expect(label).toMatch(PIN_LABEL_RE);
    expect(label.length).toBeLessThanOrEqual(128);
  });

  test("distinct unsafe ids never collide", async () => {
    const a = await pinLabelForAssistant("team alpha");
    const b = await pinLabelForAssistant("team-alpha");
    const c = await pinLabelForAssistant("team_alpha");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("falls back to the hash alone when nothing readable survives", async () => {
    const label = await pinLabelForAssistant("\u2603\u2603");
    expect(label).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic", async () => {
    expect(await pinLabelForAssistant("My Assistant")).toBe(
      await pinLabelForAssistant("My Assistant"),
    );
  });
});
