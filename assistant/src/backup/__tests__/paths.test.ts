import { afterEach, describe, expect, test } from "bun:test";

import {
  formatBackupFilename,
  getBackupKeyPath,
  getBackupRootDir,
  getDefaultOffsiteBackupsDir,
  getLocalBackupsDir,
  parseBackupTimestamp,
  resolveOffsiteDestinations,
} from "../paths.js";
import { getSnapshotLockPath } from "../snapshot-lock.js";

describe("getLocalBackupsDir", () => {
  test("returns a path containing /backups/local when no override is given", () => {
    const dir = getLocalBackupsDir();
    expect(dir).toContain("/backups/local");
  });

  test("returns the override unchanged when provided", () => {
    expect(getLocalBackupsDir("/tmp/x")).toBe("/tmp/x");
  });

  test("treats null override as absent", () => {
    const dir = getLocalBackupsDir(null);
    expect(dir).toContain("/backups/local");
  });
});

// ---------------------------------------------------------------------------
// VELLUM_BACKUP_DIR env var override
// ---------------------------------------------------------------------------

describe("VELLUM_BACKUP_DIR override", () => {
  const ORIGINAL = process.env.VELLUM_BACKUP_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.VELLUM_BACKUP_DIR;
    } else {
      process.env.VELLUM_BACKUP_DIR = ORIGINAL;
    }
  });

  test("getBackupRootDir() uses VELLUM_BACKUP_DIR when set", () => {
    process.env.VELLUM_BACKUP_DIR = "/workspace/.backups";
    expect(getBackupRootDir()).toBe("/workspace/.backups");
  });

  test("getBackupRootDir() falls back to ~/.vellum/backups when unset", () => {
    delete process.env.VELLUM_BACKUP_DIR;
    const dir = getBackupRootDir();
    expect(dir).toMatch(/\/\.vellum\/backups$/);
  });

  test("getLocalBackupsDir() resolves under VELLUM_BACKUP_DIR", () => {
    process.env.VELLUM_BACKUP_DIR = "/workspace/.backups";
    expect(getLocalBackupsDir()).toBe("/workspace/.backups/local");
  });

  test("getLocalBackupsDir() falls back to default when env var is unset", () => {
    delete process.env.VELLUM_BACKUP_DIR;
    expect(getLocalBackupsDir()).toMatch(/\/\.vellum\/backups\/local$/);
  });

  test("config override still takes precedence over VELLUM_BACKUP_DIR", () => {
    process.env.VELLUM_BACKUP_DIR = "/workspace/.backups";
    expect(getLocalBackupsDir("/custom/dir")).toBe("/custom/dir");
  });

  test("getSnapshotLockPath() resolves under VELLUM_BACKUP_DIR", () => {
    process.env.VELLUM_BACKUP_DIR = "/workspace/.backups";
    expect(getSnapshotLockPath()).toBe("/workspace/.backups/.snapshot.lock");
  });

  test("getSnapshotLockPath() falls back to default when env var is unset", () => {
    delete process.env.VELLUM_BACKUP_DIR;
    expect(getSnapshotLockPath()).toMatch(
      /\/\.vellum\/backups\/\.snapshot\.lock$/,
    );
  });
});

describe("getDefaultOffsiteBackupsDir", () => {
  test("points at the iCloud Drive VellumAssistant backups folder", () => {
    const dir = getDefaultOffsiteBackupsDir();
    expect(dir).toContain("com~apple~CloudDocs/VellumAssistant/backups");
  });
});

describe("resolveOffsiteDestinations", () => {
  test("returns iCloud default with encrypt=true when override is null", () => {
    const result = resolveOffsiteDestinations(null);
    expect(result).toHaveLength(1);
    expect(result[0].encrypt).toBe(true);
    expect(result[0].path).toContain(
      "com~apple~CloudDocs/VellumAssistant/backups",
    );
  });

  test("returns iCloud default when override is undefined", () => {
    const result = resolveOffsiteDestinations(undefined);
    expect(result).toHaveLength(1);
    expect(result[0].encrypt).toBe(true);
  });

  test("returns an empty array unchanged", () => {
    expect(resolveOffsiteDestinations([])).toEqual([]);
  });

  test("returns a multi-destination override unchanged", () => {
    const destinations = [
      { path: "/tmp/a", encrypt: true },
      { path: "/tmp/b", encrypt: false },
    ];
    expect(resolveOffsiteDestinations(destinations)).toEqual(destinations);
  });
});

describe("getBackupKeyPath", () => {
  afterEach(() => {
    delete process.env.VELLUM_BACKUP_KEY_PATH;
  });

  test("ends with /protected/backup.key when env var is unset", () => {
    delete process.env.VELLUM_BACKUP_KEY_PATH;
    expect(getBackupKeyPath().endsWith("/protected/backup.key")).toBe(true);
  });

  test("returns the env var override when VELLUM_BACKUP_KEY_PATH is set", () => {
    process.env.VELLUM_BACKUP_KEY_PATH = "/workspace/.backup.key";
    expect(getBackupKeyPath()).toBe("/workspace/.backup.key");
  });
});

describe("formatBackupFilename", () => {
  const fixture = new Date("2026-04-11T15:30:45.000Z");

  test("formats a plaintext backup filename", () => {
    expect(formatBackupFilename(fixture, { encrypted: false })).toBe(
      "backup-20260411-153045-000.vbundle",
    );
  });

  test("formats an encrypted backup filename", () => {
    expect(formatBackupFilename(fixture, { encrypted: true })).toBe(
      "backup-20260411-153045-000.vbundle.enc",
    );
  });

  test("zero-pads single-digit UTC components", () => {
    const early = new Date("2026-01-02T03:04:05.007Z");
    expect(formatBackupFilename(early, { encrypted: false })).toBe(
      "backup-20260102-030405-007.vbundle",
    );
  });

  test("includes milliseconds so same-second backups get distinct filenames", () => {
    const a = new Date("2026-04-11T15:30:45.001Z");
    const b = new Date("2026-04-11T15:30:45.002Z");
    expect(formatBackupFilename(a, { encrypted: false })).not.toBe(
      formatBackupFilename(b, { encrypted: false }),
    );
  });
});

describe("parseBackupTimestamp", () => {
  test("round-trips a plaintext backup filename with milliseconds", () => {
    const parsed = parseBackupTimestamp("backup-20260411-153045-123.vbundle");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-04-11T15:30:45.123Z");
  });

  test("round-trips an encrypted backup filename with milliseconds", () => {
    const parsed = parseBackupTimestamp(
      "backup-20260411-153045-123.vbundle.enc",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-04-11T15:30:45.123Z");
  });

  test("accepts legacy filenames without the milliseconds segment (treated as .000)", () => {
    const parsed = parseBackupTimestamp("backup-20260411-153045.vbundle");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-04-11T15:30:45.000Z");
  });

  test("accepts legacy encrypted filenames without the milliseconds segment", () => {
    const parsed = parseBackupTimestamp("backup-20260411-153045.vbundle.enc");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-04-11T15:30:45.000Z");
  });

  test("returns null for non-backup filenames", () => {
    expect(parseBackupTimestamp("not-a-backup.txt")).toBeNull();
  });

  test("returns null for a filename with the wrong prefix", () => {
    expect(parseBackupTimestamp("snapshot-20260411-153045.vbundle")).toBeNull();
  });

  test("returns null for a filename with the wrong extension", () => {
    expect(parseBackupTimestamp("backup-20260411-153045.tar.gz")).toBeNull();
  });

  test("returns null for out-of-range calendar dates (Feb 31)", () => {
    // `new Date("2026-02-31T...")` silently normalizes to March 3. Without a
    // round-trip check this would misorder retention.
    expect(parseBackupTimestamp("backup-20260231-000000.vbundle")).toBeNull();
  });

  test("returns null for other normalized-invalid dates", () => {
    // Month 13, day 32, hour 24, April 31 all normalize silently.
    expect(parseBackupTimestamp("backup-20261301-000000.vbundle")).toBeNull();
    expect(parseBackupTimestamp("backup-20260132-000000.vbundle")).toBeNull();
    expect(parseBackupTimestamp("backup-20260431-000000.vbundle")).toBeNull();
  });

  test("accepts Feb 29 in a leap year", () => {
    const parsed = parseBackupTimestamp("backup-20240229-120000.vbundle");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2024-02-29T12:00:00.000Z");
  });

  test("returns null for Feb 29 in a non-leap year", () => {
    expect(parseBackupTimestamp("backup-20260229-000000.vbundle")).toBeNull();
  });
});
