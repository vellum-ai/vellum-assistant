/**
 * Tests for `writeLocalSnapshot` and `pruneLocalSnapshots`. All tests run
 * against a temp directory to keep the real `~/.vellum/` tree untouched.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listSnapshotsInDir } from "../list-snapshots.js";
import { pruneLocalSnapshots, writeLocalSnapshot } from "../local-writer.js";

describe("writeLocalSnapshot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vellum-local-writer-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("creates the target directory if missing and moves the temp file to the final name", async () => {
    const tempPath = join(root, "stage.vbundle.tmp");
    const payload = "fake bundle bytes";
    writeFileSync(tempPath, payload);

    // Nest one level so the writer must mkdir -p.
    const localDir = join(root, "backups", "local");
    const now = new Date("2026-04-11T15:30:45Z");

    const entry = await writeLocalSnapshot(tempPath, localDir, now);

    expect(entry.filename).toBe("backup-20260411-153045.vbundle");
    expect(entry.path).toBe(join(localDir, "backup-20260411-153045.vbundle"));
    expect(entry.encrypted).toBe(false);
    expect(entry.createdAt).toBe(now);
    expect(entry.sizeBytes).toBe(Buffer.byteLength(payload));

    // Final file exists with the original payload.
    expect(existsSync(entry.path)).toBe(true);
    expect(readFileSync(entry.path, "utf8")).toBe(payload);
    // Source temp file is gone (rename or copy+unlink, both clean up).
    expect(existsSync(tempPath)).toBe(false);
  });

  test("returned SnapshotEntry has the correct filename, size, and timestamp", async () => {
    const tempPath = join(root, "stage.tmp");
    const payload = Buffer.alloc(1234, 0xab);
    writeFileSync(tempPath, payload);

    const localDir = join(root, "local");
    const now = new Date("2026-01-02T03:04:05Z");
    const entry = await writeLocalSnapshot(tempPath, localDir, now);

    expect(entry.filename).toBe("backup-20260102-030405.vbundle");
    expect(entry.sizeBytes).toBe(1234);
    expect(entry.createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    // listSnapshotsInDir should round-trip the same entry.
    const listed = await listSnapshotsInDir(localDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].filename).toBe(entry.filename);
    expect(listed[0].sizeBytes).toBe(entry.sizeBytes);
    expect(listed[0].createdAt.toISOString()).toBe(
      entry.createdAt.toISOString(),
    );
  });
});

describe("pruneLocalSnapshots", () => {
  let root: string;
  let localDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vellum-prune-local-"));
    localDir = join(root, "local");
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Helper: drop N timestamped backup files into `localDir`. */
  async function seed(count: number): Promise<string[]> {
    await import("node:fs/promises").then((fsp) =>
      fsp.mkdir(localDir, { recursive: true, mode: 0o700 }),
    );
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      // Use ascending hours so file index N is the Nth-oldest, with the
      // last seeded entry being the newest.
      const hour = i.toString().padStart(2, "0");
      const name = `backup-20260411-${hour}0000.vbundle`;
      writeFileSync(join(localDir, name), `payload ${i}`);
      names.push(name);
    }
    return names;
  }

  test("with 7 existing + retention 3 keeps the 3 newest and deletes 4", async () => {
    const seeded = await seed(7);
    const expectedKept = seeded.slice(-3).reverse(); // newest-first
    const expectedDeleted = seeded.slice(0, 4).reverse(); // newest-first within deletes

    const result = await pruneLocalSnapshots(localDir, 3);

    expect(result.kept.map((e) => e.filename)).toEqual(expectedKept);
    expect(result.deleted.map((e) => e.filename)).toEqual(expectedDeleted);

    // Filesystem matches.
    const remaining = await listSnapshotsInDir(localDir);
    expect(remaining.map((e) => e.filename)).toEqual(expectedKept);
    for (const name of expectedDeleted) {
      expect(existsSync(join(localDir, name))).toBe(false);
    }
  });

  test("retention >= count keeps everything", async () => {
    const seeded = await seed(3);
    const result = await pruneLocalSnapshots(localDir, 10);
    expect(result.deleted).toEqual([]);
    expect(result.kept.map((e) => e.filename)).toEqual(
      seeded.slice().reverse(),
    );
    // All files still on disk.
    const remaining = await listSnapshotsInDir(localDir);
    expect(remaining).toHaveLength(3);
  });

  test("retention === count keeps everything (boundary)", async () => {
    await seed(3);
    const result = await pruneLocalSnapshots(localDir, 3);
    expect(result.deleted).toEqual([]);
    expect(result.kept).toHaveLength(3);
  });

  test("retention 0 deletes everything (defensive — config schema rejects 0)", async () => {
    const seeded = await seed(4);
    const result = await pruneLocalSnapshots(localDir, 0);
    expect(result.kept).toEqual([]);
    expect(result.deleted).toHaveLength(4);
    for (const name of seeded) {
      expect(existsSync(join(localDir, name))).toBe(false);
    }
    const remaining = await listSnapshotsInDir(localDir);
    expect(remaining).toEqual([]);
  });

  test("missing directory returns empty kept/deleted", async () => {
    const result = await pruneLocalSnapshots(join(root, "nope"), 3);
    expect(result.kept).toEqual([]);
    expect(result.deleted).toEqual([]);
  });
});
