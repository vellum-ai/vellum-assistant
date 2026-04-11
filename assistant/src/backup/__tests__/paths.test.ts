import { describe, expect, test } from "bun:test";

import {
  formatBackupFilename,
  getBackupKeyPath,
  getDefaultOffsiteBackupsDir,
  getLocalBackupsDir,
  parseBackupTimestamp,
  resolveOffsiteDestinations,
} from "../paths.js";

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
  test("ends with /protected/backup.key", () => {
    expect(getBackupKeyPath().endsWith("/protected/backup.key")).toBe(true);
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
