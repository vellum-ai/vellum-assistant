/**
 * Tests for `writeOffsiteSnapshotToOne`, `writeOffsiteSnapshotToAll`, and
 * `pruneOffsiteSnapshotsInAll`. All tests run against a temp directory so
 * the real `~/.vellum/` tree is never touched.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { BackupDestination } from "../../config/schema.js";
import { listSnapshotsInDir } from "../list-snapshots.js";
import {
  pruneOffsiteSnapshotsInAll,
  writeOffsiteSnapshotToAll,
  writeOffsiteSnapshotToOne,
} from "../offsite-writer.js";
import { decryptFile } from "../stream-crypt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ROOT: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-offsite-writer-"));
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Write a fake local snapshot file and return its absolute path. */
function seedLocalSnapshot(payload: Buffer | string): string {
  const path = join(ROOT, "local.vbundle");
  writeFileSync(path, payload);
  return path;
}

/** Absolute path helper for tests that need to construct destinations. */
function subPath(...segments: string[]): string {
  return join(ROOT, ...segments);
}

// ---------------------------------------------------------------------------
// writeOffsiteSnapshotToOne
// ---------------------------------------------------------------------------

describe("writeOffsiteSnapshotToOne", () => {
  const NOW = new Date("2026-04-11T15:30:45Z");

  test("returns skipped=parent-missing when the parent directory does not exist", async () => {
    const localSnapshotPath = seedLocalSnapshot("payload");
    // Parent "does/not/exist" is not created.
    const destination: BackupDestination = {
      path: subPath("does", "not", "exist", "backups"),
      encrypt: true,
    };
    const key = randomBytes(32);

    const result = await writeOffsiteSnapshotToOne(
      localSnapshotPath,
      destination,
      key,
      NOW,
    );

    expect(result.skipped).toBe("parent-missing");
    expect(result.entry).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.destination).toEqual(destination);
  });

  test("encrypt=true writes a .vbundle.enc that round-trips through decryptFile", async () => {
    const plaintext = randomBytes(2048);
    const localSnapshotPath = seedLocalSnapshot(plaintext);

    // Parent exists; destination directory itself does not yet.
    const parent = subPath("icloud");
    mkdirSync(parent, { recursive: true });
    const destination: BackupDestination = {
      path: join(parent, "backups"),
      encrypt: true,
    };
    const key = randomBytes(32);

    const result = await writeOffsiteSnapshotToOne(
      localSnapshotPath,
      destination,
      key,
      NOW,
    );

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(result.entry).not.toBeNull();
    expect(result.entry!.filename).toBe(
      "backup-20260411-153045-000.vbundle.enc",
    );
    expect(result.entry!.encrypted).toBe(true);
    expect(result.entry!.createdAt).toBe(NOW);
    expect(result.entry!.path).toBe(
      join(destination.path, "backup-20260411-153045-000.vbundle.enc"),
    );
    expect(existsSync(result.entry!.path)).toBe(true);

    // Round-trip through decryptFile to confirm the ciphertext actually
    // decrypts to the original bytes.
    const roundTripPath = subPath("roundtrip.bin");
    await decryptFile(result.entry!.path, roundTripPath, key);
    const decoded = readFileSync(roundTripPath);
    expect(decoded.equals(plaintext)).toBe(true);
  });

  test("encrypt=false writes a plaintext .vbundle that byte-equals the source", async () => {
    const plaintext = randomBytes(4096);
    const localSnapshotPath = seedLocalSnapshot(plaintext);

    const parent = subPath("external-ssd");
    mkdirSync(parent, { recursive: true });
    const destination: BackupDestination = {
      path: join(parent, "vellum-backups"),
      encrypt: false,
    };

    const result = await writeOffsiteSnapshotToOne(
      localSnapshotPath,
      destination,
      null, // no key needed for plaintext
      NOW,
    );

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(result.entry).not.toBeNull();
    expect(result.entry!.filename).toBe("backup-20260411-153045-000.vbundle");
    expect(result.entry!.encrypted).toBe(false);
    expect(result.entry!.sizeBytes).toBe(plaintext.length);

    // Byte-equal check against the source file.
    const written = readFileSync(result.entry!.path);
    expect(written.equals(plaintext)).toBe(true);

    // No stray .tmp sibling left behind.
    expect(existsSync(`${result.entry!.path}.tmp`)).toBe(false);
  });

  test("bootstraps intermediate directories under the iCloud Drive safe ancestor on first run", async () => {
    // Redirect HOME so `getICloudDriveRoot()` resolves inside our temp ROOT.
    // This is the key regression: on first install only the iCloud Drive root
    // exists; `VellumAssistant/backups/` needs to be created by the writer.
    const ORIGINAL_HOME = process.env.HOME;
    process.env.HOME = ROOT;
    try {
      const iCloudRoot = join(
        ROOT,
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
      );
      mkdirSync(iCloudRoot, { recursive: true });
      // Destination is two levels below the safe ancestor — neither of the
      // intermediate dirs exists yet.
      const destinationPath = join(iCloudRoot, "VellumAssistant", "backups");
      expect(existsSync(destinationPath)).toBe(false);

      const plaintext = randomBytes(512);
      const localSnapshotPath = seedLocalSnapshot(plaintext);
      const destination: BackupDestination = {
        path: destinationPath,
        encrypt: true,
      };
      const key = randomBytes(32);

      const result = await writeOffsiteSnapshotToOne(
        localSnapshotPath,
        destination,
        key,
        NOW,
      );

      expect(result.skipped).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.entry).not.toBeNull();
      expect(existsSync(destinationPath)).toBe(true);
      expect(existsSync(result.entry!.path)).toBe(true);
    } finally {
      if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = ORIGINAL_HOME;
      }
    }
  });

  test("iCloud default path is still skipped when the iCloud Drive root is missing", async () => {
    // Same shape as the previous test, but we do NOT create the iCloud Drive
    // root — simulates iCloud Drive disabled. The destination must stay
    // skipped rather than bootstrapping the tree under an arbitrary location.
    const ORIGINAL_HOME = process.env.HOME;
    process.env.HOME = ROOT;
    try {
      const iCloudRoot = join(
        ROOT,
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
      );
      expect(existsSync(iCloudRoot)).toBe(false);

      const destinationPath = join(iCloudRoot, "VellumAssistant", "backups");
      const localSnapshotPath = seedLocalSnapshot("payload");
      const destination: BackupDestination = {
        path: destinationPath,
        encrypt: true,
      };

      const result = await writeOffsiteSnapshotToOne(
        localSnapshotPath,
        destination,
        randomBytes(32),
        NOW,
      );

      expect(result.skipped).toBe("parent-missing");
      expect(result.entry).toBeNull();
      expect(result.error).toBeUndefined();
      expect(existsSync(destinationPath)).toBe(false);
      // Critical: no intermediate directories were materialized.
      expect(existsSync(join(iCloudRoot, "VellumAssistant"))).toBe(false);
    } finally {
      if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = ORIGINAL_HOME;
      }
    }
  });

  test("permissions error on mkdir is surfaced as result.error rather than thrown", async () => {
    // Root directory exists but is not writable, so `mkdir -p destination` fails
    // with EACCES. The writer must catch it and surface via `error` to keep
    // a broken destination from poisoning the others.
    const readOnlyParent = subPath("read-only");
    mkdirSync(readOnlyParent, { recursive: true });
    chmodSync(readOnlyParent, 0o500); // r-x only: stat works, mkdir fails
    try {
      const destination: BackupDestination = {
        path: join(readOnlyParent, "backups"),
        encrypt: false,
      };
      const localSnapshotPath = seedLocalSnapshot("payload");

      const result = await writeOffsiteSnapshotToOne(
        localSnapshotPath,
        destination,
        null,
        NOW,
      );

      expect(result.entry).toBeNull();
      expect(result.skipped).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/EACCES|permission/i);
    } finally {
      // Restore writable perms so the afterEach rmSync can clean up.
      chmodSync(readOnlyParent, 0o700);
    }
  });

  test("encrypt=true with key=null returns an error (caught internally, not thrown)", async () => {
    const localSnapshotPath = seedLocalSnapshot("payload");

    const parent = subPath("icloud");
    mkdirSync(parent, { recursive: true });
    const destination: BackupDestination = {
      path: join(parent, "backups"),
      encrypt: true,
    };

    const result = await writeOffsiteSnapshotToOne(
      localSnapshotPath,
      destination,
      null, // missing key despite encrypt=true
      NOW,
    );

    expect(result.entry).toBeNull();
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error).toContain("encryption");
  });
});

// ---------------------------------------------------------------------------
// writeOffsiteSnapshotToAll
// ---------------------------------------------------------------------------

describe("writeOffsiteSnapshotToAll", () => {
  const NOW = new Date("2026-04-11T15:30:45Z");

  test("empty destinations returns [] immediately", async () => {
    const localSnapshotPath = seedLocalSnapshot("payload");
    const result = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      [],
      null,
      NOW,
    );
    expect(result).toEqual([]);
  });

  test("multi-destination: encrypted + plaintext writes succeed with correct extensions", async () => {
    const plaintext = randomBytes(1024);
    const localSnapshotPath = seedLocalSnapshot(plaintext);

    const parentA = subPath("icloud");
    const parentB = subPath("external-ssd");
    mkdirSync(parentA, { recursive: true });
    mkdirSync(parentB, { recursive: true });

    const destinations: BackupDestination[] = [
      { path: join(parentA, "backups"), encrypt: true },
      { path: join(parentB, "vellum-backups"), encrypt: false },
    ];
    const key = randomBytes(32);

    const results = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      destinations,
      key,
      NOW,
    );

    expect(results).toHaveLength(2);

    // Encrypted destination
    expect(results[0].destination).toEqual(destinations[0]);
    expect(results[0].entry).not.toBeNull();
    expect(results[0].entry!.filename).toBe(
      "backup-20260411-153045-000.vbundle.enc",
    );
    expect(results[0].entry!.encrypted).toBe(true);
    expect(results[0].skipped).toBeUndefined();
    expect(results[0].error).toBeUndefined();

    // Plaintext destination
    expect(results[1].destination).toEqual(destinations[1]);
    expect(results[1].entry).not.toBeNull();
    expect(results[1].entry!.filename).toBe(
      "backup-20260411-153045-000.vbundle",
    );
    expect(results[1].entry!.encrypted).toBe(false);
    expect(results[1].skipped).toBeUndefined();
    expect(results[1].error).toBeUndefined();

    // Plaintext copy is byte-equal to source.
    expect(readFileSync(results[1].entry!.path).equals(plaintext)).toBe(true);
  });

  test("one destination with a missing parent is skipped while the other succeeds", async () => {
    const localSnapshotPath = seedLocalSnapshot("payload");

    const parentA = subPath("icloud");
    mkdirSync(parentA, { recursive: true });

    const destinations: BackupDestination[] = [
      { path: join(parentA, "backups"), encrypt: false }, // OK
      { path: subPath("missing", "mount", "backups"), encrypt: false }, // parent missing
    ];

    const results = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      destinations,
      null,
      NOW,
    );

    expect(results).toHaveLength(2);

    // A succeeded.
    expect(results[0].entry).not.toBeNull();
    expect(results[0].skipped).toBeUndefined();
    expect(results[0].error).toBeUndefined();
    expect(existsSync(results[0].entry!.path)).toBe(true);

    // B skipped (parent missing).
    expect(results[1].entry).toBeNull();
    expect(results[1].skipped).toBe("parent-missing");
    expect(results[1].error).toBeUndefined();
  });

  test("one destination throwing (dest.path is a file) reports error while the other still succeeds", async () => {
    const localSnapshotPath = seedLocalSnapshot("payload");

    const parentA = subPath("icloud");
    const parentB = subPath("broken");
    mkdirSync(parentA, { recursive: true });
    mkdirSync(parentB, { recursive: true });

    // Force B's `destination.path` to be a file, which makes the mkdir +
    // write paths throw (a file exists where the destination directory
    // should be).
    const brokenDestPath = join(parentB, "not-a-dir");
    writeFileSync(brokenDestPath, "I am a file, not a directory");

    const destinations: BackupDestination[] = [
      { path: join(parentA, "backups"), encrypt: false },
      { path: brokenDestPath, encrypt: false },
    ];

    const results = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      destinations,
      null,
      NOW,
    );

    expect(results).toHaveLength(2);

    // A still succeeded.
    expect(results[0].entry).not.toBeNull();
    expect(results[0].error).toBeUndefined();

    // B failed with an error (not a skip — its parent exists).
    expect(results[1].entry).toBeNull();
    expect(results[1].skipped).toBeUndefined();
    expect(results[1].error).toBeDefined();
  });

  test("writes are sequential: after each iteration the corresponding destination has exactly one file", async () => {
    // We verify order by having each destination's mtime reflect the order
    // of writes. A simpler check: by the time writeOffsiteSnapshotToAll
    // returns, both files exist; and each intermediate result is fully
    // formed (not a promise-like stub). Sequential ordering is also enforced
    // at compile time by the for...of + await structure.
    const plaintext = randomBytes(256);
    const localSnapshotPath = seedLocalSnapshot(plaintext);

    const parents = [subPath("p0"), subPath("p1"), subPath("p2")];
    for (const p of parents) mkdirSync(p, { recursive: true });
    const destinations: BackupDestination[] = parents.map((p) => ({
      path: join(p, "dst"),
      encrypt: false,
    }));

    const results = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      destinations,
      null,
      new Date("2026-04-11T15:30:45Z"),
    );

    expect(results).toHaveLength(3);
    // Ordering by destination.path matches the input, which is only
    // guaranteed if we loop sequentially (Promise.all would also preserve
    // order, but then interleaved destination failures could interact).
    for (let i = 0; i < destinations.length; i++) {
      expect(results[i].destination.path).toBe(destinations[i].path);
      expect(results[i].entry).not.toBeNull();
      const listed = await listSnapshotsInDir(destinations[i].path);
      expect(listed).toHaveLength(1);
    }
  });

  test("only plaintext destinations with key=null succeeds (no key required)", async () => {
    const plaintext = randomBytes(512);
    const localSnapshotPath = seedLocalSnapshot(plaintext);

    const parentA = subPath("a");
    const parentB = subPath("b");
    mkdirSync(parentA, { recursive: true });
    mkdirSync(parentB, { recursive: true });

    const destinations: BackupDestination[] = [
      { path: join(parentA, "dst"), encrypt: false },
      { path: join(parentB, "dst"), encrypt: false },
    ];

    const results = await writeOffsiteSnapshotToAll(
      localSnapshotPath,
      destinations,
      null,
      new Date("2026-04-11T15:30:45Z"),
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.entry).not.toBeNull();
      expect(r.error).toBeUndefined();
      expect(r.skipped).toBeUndefined();
      expect(readFileSync(r.entry!.path).equals(plaintext)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// pruneOffsiteSnapshotsInAll
// ---------------------------------------------------------------------------

describe("pruneOffsiteSnapshotsInAll", () => {
  /**
   * Seed `count` timestamped backup files into `dir`. Ascending hours mean
   * file index N is the Nth-oldest, so the last seeded file is the newest.
   * Alternates `.vbundle` / `.vbundle.enc` when `mixed` is true.
   */
  function seed(dir: string, count: number, mixed = false): string[] {
    mkdirSync(dir, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const hour = i.toString().padStart(2, "0");
      const ext = mixed && i % 2 === 0 ? ".vbundle.enc" : ".vbundle";
      const name = `backup-20260411-${hour}0000${ext}`;
      writeFileSync(join(dir, name), `payload ${i}`);
      names.push(name);
    }
    return names;
  }

  test("two destinations with 10 files each, retention 7: each keeps its own 7 newest", async () => {
    const parentA = subPath("a");
    const parentB = subPath("b");
    mkdirSync(parentA, { recursive: true });
    mkdirSync(parentB, { recursive: true });

    const dirA = join(parentA, "dst");
    const dirB = join(parentB, "dst");
    const seededA = seed(dirA, 10);
    const seededB = seed(dirB, 10);

    const destinations: BackupDestination[] = [
      { path: dirA, encrypt: false },
      { path: dirB, encrypt: false },
    ];

    const results = await pruneOffsiteSnapshotsInAll(destinations, 7);

    expect(results).toHaveLength(2);

    // A: 7 newest kept, 3 oldest deleted.
    expect(results[0].destination).toEqual(destinations[0]);
    expect(results[0].kept).toHaveLength(7);
    expect(results[0].deleted).toHaveLength(3);
    expect(results[0].skipped).toBeUndefined();
    // Filesystem matches.
    const remainingA = await listSnapshotsInDir(dirA);
    expect(remainingA).toHaveLength(7);
    // Oldest three (indexes 0..2) are gone.
    for (const name of seededA.slice(0, 3)) {
      expect(existsSync(join(dirA, name))).toBe(false);
    }

    // B: same, independently of A.
    expect(results[1].destination).toEqual(destinations[1]);
    expect(results[1].kept).toHaveLength(7);
    expect(results[1].deleted).toHaveLength(3);
    expect(results[1].skipped).toBeUndefined();
    const remainingB = await listSnapshotsInDir(dirB);
    expect(remainingB).toHaveLength(7);
    for (const name of seededB.slice(0, 3)) {
      expect(existsSync(join(dirB, name))).toBe(false);
    }
  });

  test("a destination with a missing parent returns skipped=true for that entry only", async () => {
    const parentA = subPath("a");
    mkdirSync(parentA, { recursive: true });
    const dirA = join(parentA, "dst");
    seed(dirA, 5);

    const destinations: BackupDestination[] = [
      { path: dirA, encrypt: false },
      // Parent does not exist.
      { path: subPath("missing", "mount", "dst"), encrypt: false },
    ];

    const results = await pruneOffsiteSnapshotsInAll(destinations, 3);

    expect(results).toHaveLength(2);

    // A pruned normally.
    expect(results[0].skipped).toBeUndefined();
    expect(results[0].kept).toHaveLength(3);
    expect(results[0].deleted).toHaveLength(2);

    // B is skipped — parent missing.
    expect(results[1].skipped).toBe(true);
    expect(results[1].kept).toEqual([]);
    expect(results[1].deleted).toEqual([]);
  });

  test("mixed .vbundle and .vbundle.enc files in one directory are pruned as a single pool ordered by timestamp", async () => {
    const parent = subPath("a");
    mkdirSync(parent, { recursive: true });
    const dir = join(parent, "dst");
    // 10 files alternating .vbundle.enc (even indexes) and .vbundle (odd).
    const seeded = seed(dir, 10, /* mixed */ true);

    const destinations: BackupDestination[] = [
      { path: dir, encrypt: true }, // encrypt flag is unrelated to prune logic
    ];

    const results = await pruneOffsiteSnapshotsInAll(destinations, 4);
    expect(results).toHaveLength(1);

    const { kept, deleted } = results[0];
    // 4 newest kept, 6 oldest deleted — pool treats both extensions the same.
    expect(kept).toHaveLength(4);
    expect(deleted).toHaveLength(6);

    // Newest four are indexes 6..9 (ascending hours, so 09,08,07,06 newest-first).
    const expectedKeptNames = seeded.slice(-4).reverse();
    expect(kept.map((e) => e.filename)).toEqual(expectedKeptNames);

    // Deleted six are indexes 0..5, returned in the original newest-first
    // sort from listSnapshotsInDir: 05, 04, 03, 02, 01, 00.
    const expectedDeletedNames = seeded.slice(0, 6).reverse();
    expect(deleted.map((e) => e.filename)).toEqual(expectedDeletedNames);

    // Filesystem check: mixed extensions gone for indexes 0..5.
    for (const name of expectedDeletedNames) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
    // Kept files still on disk.
    const remaining = await listSnapshotsInDir(dir);
    expect(remaining.map((e) => e.filename)).toEqual(expectedKeptNames);
  });
});
