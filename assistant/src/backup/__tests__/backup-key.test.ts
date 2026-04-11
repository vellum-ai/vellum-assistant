/**
 * Tests for the backup key read/generate helpers. All tests run against a
 * temp directory and explicitly pass the key path -- nothing touches the
 * real `~/.vellum/` tree or depends on daemon startup state.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

    test("does not leave a .tmp file behind after a successful write", async () => {
      await ensureBackupKey(keyPath);
      const tmpPath = `${keyPath}.tmp.${process.pid}`;
      expect(() => statSync(tmpPath)).toThrow();
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
