/**
 * Tests for `listSnapshotsInDir`. All tests run against a freshly-minted
 * temp directory to avoid touching the real `~/.vellum/` tree.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listSnapshotsInDir } from "../list-snapshots.js";

describe("listSnapshotsInDir", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vellum-list-snapshots-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("empty directory returns []", async () => {
    const result = await listSnapshotsInDir(root);
    expect(result).toEqual([]);
  });

  test("missing directory returns [] and does not throw", async () => {
    const missing = join(root, "does-not-exist");
    const result = await listSnapshotsInDir(missing);
    expect(result).toEqual([]);
  });

  test("returns three backup files newest-first", async () => {
    const names = [
      "backup-20260411-100000.vbundle",
      "backup-20260411-120000.vbundle",
      "backup-20260411-110000.vbundle",
    ];
    for (const name of names) {
      writeFileSync(join(root, name), `payload ${name}`);
    }

    const result = await listSnapshotsInDir(root);
    expect(result.map((e) => e.filename)).toEqual([
      "backup-20260411-120000.vbundle",
      "backup-20260411-110000.vbundle",
      "backup-20260411-100000.vbundle",
    ]);
    // Each entry has the right size and the parsed UTC timestamp.
    expect(result[0].sizeBytes).toBe(
      Buffer.byteLength("payload backup-20260411-120000.vbundle"),
    );
    expect(result[0].createdAt.toISOString()).toBe("2026-04-11T12:00:00.000Z");
    expect(result[0].path).toBe(join(root, "backup-20260411-120000.vbundle"));
  });

  test("non-backup files are filtered out", async () => {
    writeFileSync(join(root, "backup-20260411-120000.vbundle"), "real");
    writeFileSync(join(root, "README.md"), "not a backup");
    writeFileSync(join(root, "backup-20260411.vbundle"), "wrong shape");
    writeFileSync(join(root, ".DS_Store"), "junk");

    const result = await listSnapshotsInDir(root);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("backup-20260411-120000.vbundle");
  });

  test("mixed .vbundle and .vbundle.enc files set encrypted flag correctly", async () => {
    writeFileSync(join(root, "backup-20260411-100000.vbundle"), "plain");
    writeFileSync(join(root, "backup-20260411-110000.vbundle.enc"), "ciphered");

    const result = await listSnapshotsInDir(root);
    // Newest first.
    expect(result.map((e) => e.filename)).toEqual([
      "backup-20260411-110000.vbundle.enc",
      "backup-20260411-100000.vbundle",
    ]);
    expect(result[0].encrypted).toBe(true);
    expect(result[1].encrypted).toBe(false);
  });
});
