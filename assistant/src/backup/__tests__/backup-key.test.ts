/**
 * Tests for the backup key read/generate helpers. All tests run against a
 * temp directory and explicitly pass the key path -- nothing touches the
 * real `~/.vellum/` tree or depends on daemon startup state.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { ensureBackupKey, readBackupKey } from "../backup-key.js";

describe("backup-key", () => {
  let root: string;
  let keyPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vellum-backup-key-"));
    // Nest the key file one level down so we can verify that the
    // parent directory is created on demand with the expected mode.
    keyPath = join(root, "backup", "backup.key");
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe("ensureBackupKey", () => {
    test("first call generates a fresh 32-byte key and writes it with mode 0600", async () => {
      const key = await ensureBackupKey(keyPath);

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);

      const fileMode = statSync(keyPath).mode & 0o777;
      expect(fileMode).toBe(0o600);
    });

    test("creates the parent directory with mode 0700 when missing", async () => {
      await ensureBackupKey(keyPath);

      const parent = join(root, "backup");
      const dirMode = statSync(parent).mode & 0o777;
      // On some platforms umask can strip bits further, but it must
      // never be more permissive than 0o700.
      expect(dirMode & ~0o700).toBe(0);
      expect(dirMode & 0o700).toBe(0o700);
    });

    test("second call returns the same bytes persisted on the first call", async () => {
      const first = await ensureBackupKey(keyPath);
      const second = await ensureBackupKey(keyPath);
      expect(Buffer.compare(first, second)).toBe(0);
    });

    test("throws when an existing key file has the wrong size", async () => {
      mkdirSync(join(root, "backup"), { recursive: true, mode: 0o700 });
      // 16 bytes is half the expected length -- simulate a truncated or
      // otherwise corrupt key file.
      writeFileSync(keyPath, Buffer.alloc(16, 0xaa), { mode: 0o600 });

      await expect(ensureBackupKey(keyPath)).rejects.toThrow(
        /invalid length 16/,
      );
    });

    test("does not leave any .tmp file behind after a successful write", async () => {
      await ensureBackupKey(keyPath);
      const parent = join(root, "backup");
      const base = basename(keyPath);
      const entries = readdirSync(parent);
      const tmpEntries = entries.filter((e) => e.startsWith(`${base}.tmp.`));
      expect(tmpEntries).toEqual([]);
    });

    test("two concurrent callers converge on the same persisted bytes", async () => {
      // Race two ensureBackupKey calls. Exactly one caller's bytes win
      // the rename; the other caller must re-read the file and return
      // those same bytes rather than the key it generated locally.
      const [a, b] = await Promise.all([
        ensureBackupKey(keyPath),
        ensureBackupKey(keyPath),
      ]);
      expect(Buffer.compare(a, b)).toBe(0);
      const onDisk = statSync(keyPath);
      expect(onDisk.size).toBe(32);
    });

    test("propagates non-ENOENT stat errors instead of treating them as missing", async () => {
      // Simulate flaky storage (EIO / ESTALE). If pathExists swallowed
      // these, the key file would appear "missing" and be silently
      // regenerated, rotating away bytes used to encrypt existing data.
      const statSpy = spyOn(fsPromises, "stat").mockImplementation(
        async () => {
          const err = new Error("simulated EIO") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        },
      );
      try {
        await expect(ensureBackupKey(keyPath)).rejects.toThrow(
          /simulated EIO/,
        );
        // And the key file must NOT have been created as a side effect.
        expect(() => statSync(keyPath)).toThrow();
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  describe("readBackupKey", () => {
    test("returns null when the key file is missing", async () => {
      const result = await readBackupKey(keyPath);
      expect(result).toBeNull();
    });

    test("returns the same bytes that ensureBackupKey wrote", async () => {
      const generated = await ensureBackupKey(keyPath);
      const read = await readBackupKey(keyPath);
      expect(read).not.toBeNull();
      expect(Buffer.compare(read!, generated)).toBe(0);
    });

    test("throws when the existing key file has the wrong size", async () => {
      mkdirSync(join(root, "backup"), { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, Buffer.alloc(8, 0xff), { mode: 0o600 });

      await expect(readBackupKey(keyPath)).rejects.toThrow(/invalid length 8/);
    });
  });
});
