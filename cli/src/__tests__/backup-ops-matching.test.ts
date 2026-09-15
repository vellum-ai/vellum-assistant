import { describe, expect, test } from "bun:test";

import { assistantBackupFilenamePattern } from "../lib/backup-ops.js";

const STAMP = "2026-09-15T14-27-28-123Z";

describe("assistantBackupFilenamePattern", () => {
  test("matches this CLI's backups for exactly the given assistant", () => {
    const pattern = assistantBackupFilenamePattern("alpha");
    expect(pattern.test(`alpha-pre-upgrade-${STAMP}.vbundle`)).toBe(true);
    expect(pattern.test(`alpha-pre-teleport-${STAMP}.vbundle`)).toBe(true);
  });

  test("does not match an assistant whose id extends this one", () => {
    const pattern = assistantBackupFilenamePattern("alpha");
    expect(pattern.test(`alpha-prod-pre-upgrade-${STAMP}.vbundle`)).toBe(false);
    expect(pattern.test(`alpha-prod-pre-teleport-${STAMP}.vbundle`)).toBe(
      false,
    );
  });

  test("does not match a shorter id's backups from a longer id", () => {
    const pattern = assistantBackupFilenamePattern("alpha-prod");
    expect(pattern.test(`alpha-pre-upgrade-${STAMP}.vbundle`)).toBe(false);
  });

  test("ignores user-named vellum backup files and other kinds", () => {
    const pattern = assistantBackupFilenamePattern("alpha");
    expect(pattern.test(`alpha-${STAMP}.vbundle`)).toBe(false);
    expect(pattern.test(`alpha-manual-${STAMP}.vbundle`)).toBe(false);
    expect(pattern.test(`alpha-pre-upgrade-${STAMP}.vbundle.enc`)).toBe(false);
  });

  test("restricts to the requested kinds", () => {
    const pattern = assistantBackupFilenamePattern("alpha", ["pre-teleport"]);
    expect(pattern.test(`alpha-pre-teleport-${STAMP}.vbundle`)).toBe(true);
    expect(pattern.test(`alpha-pre-upgrade-${STAMP}.vbundle`)).toBe(false);
    expect(
      pattern.test(`alpha-pre-teleport-prod-pre-teleport-${STAMP}.vbundle`),
    ).toBe(false);
  });

  test("escapes regex metacharacters in ids", () => {
    const pattern = assistantBackupFilenamePattern("a.b");
    expect(pattern.test(`a.b-pre-upgrade-${STAMP}.vbundle`)).toBe(true);
    expect(pattern.test(`axb-pre-upgrade-${STAMP}.vbundle`)).toBe(false);
  });
});
