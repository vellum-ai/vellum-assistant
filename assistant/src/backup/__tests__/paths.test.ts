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
  const fixture = new Date("2026-04-11T15:30:45Z");

  test("formats a plaintext backup filename", () => {
    expect(formatBackupFilename(fixture, { encrypted: false })).toBe(
      "backup-20260411-153045.vbundle",
    );
  });

  test("formats an encrypted backup filename", () => {
    expect(formatBackupFilename(fixture, { encrypted: true })).toBe(
      "backup-20260411-153045.vbundle.enc",
    );
  });

  test("zero-pads single-digit UTC components", () => {
    const early = new Date("2026-01-02T03:04:05Z");
    expect(formatBackupFilename(early, { encrypted: false })).toBe(
      "backup-20260102-030405.vbundle",
    );
  });
});

describe("parseBackupTimestamp", () => {
  test("round-trips a plaintext backup filename", () => {
    const parsed = parseBackupTimestamp("backup-20260411-153045.vbundle");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-04-11T15:30:45.000Z");
  });

  test("round-trips an encrypted backup filename", () => {
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
});
