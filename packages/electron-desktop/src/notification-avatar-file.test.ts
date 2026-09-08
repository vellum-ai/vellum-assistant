import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureNotificationAvatarFile } from "./notification-avatar-file";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A distinct PNG-signed avatar per label, so each one hashes differently. */
const pngFor = (label: string): Buffer =>
  Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from(label)]);

const hashOf = (bytes: Buffer): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const PNG = pngFor("a");
const HASH = hashOf(PNG);

/** Older than the ten-minute floor the prune refuses to delete inside. */
const AGED_SECONDS = 1_700_000_000;

let userDataDir: string;

const avatarDir = (): string => path.join(userDataDir, "notification-avatars");

const age = (file: string, offset = 0): void => {
  utimesSync(file, AGED_SECONDS + offset, AGED_SECONDS + offset);
};

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-avatar-file-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("ensureNotificationAvatarFile", () => {
  test("writes the PNG under the hash and returns its absolute path", () => {
    const file = ensureNotificationAvatarFile(userDataDir, PNG, HASH);

    expect(file).toBe(path.join(avatarDir(), `${HASH}.png`));
    expect(path.isAbsolute(file)).toBe(true);
    expect(readFileSync(file)).toEqual(PNG);
  });

  test("leaves an already-written avatar alone", () => {
    const file = ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    // A rewrite renames a fresh file over this one, so a stable inode is what
    // says the bytes were re-used rather than written again.
    const inode = statSync(file).ino;

    expect(ensureNotificationAvatarFile(userDataDir, PNG, HASH)).toBe(file);
    expect(readFileSync(file)).toEqual(PNG);
    expect(statSync(file).ino).toBe(inode);
  });

  test("stamps the mtime on a hit so the prune sees it as newly used", () => {
    const file = ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    age(file);

    ensureNotificationAvatarFile(userDataDir, PNG, HASH);

    expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  test("rewrites a cache entry a partial write left behind", () => {
    const file = ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    writeFileSync(file, Buffer.alloc(0));

    expect(ensureNotificationAvatarFile(userDataDir, PNG, HASH)).toBe(file);
    expect(readFileSync(file)).toEqual(PNG);
  });

  test("prunes the aged directory to the eight newest avatars", () => {
    const written = Array.from({ length: 8 }, (_unused, index) => {
      const bytes = pngFor(`avatar-${index}`);
      const hash = hashOf(bytes);
      // Oldest first, and all past the prune floor, so the pruning order is
      // not left to write timing.
      age(ensureNotificationAvatarFile(userDataDir, bytes, hash), index);
      return hash;
    });

    const newest = pngFor("avatar-8");
    ensureNotificationAvatarFile(userDataDir, newest, hashOf(newest));

    expect(readdirSync(avatarDir()).sort()).toEqual(
      [
        ...written.slice(1).map((hash) => `${hash}.png`),
        `${hashOf(newest)}.png`,
      ].sort(),
    );
  });

  test("keeps avatars past the cap while a toast could still be reading them", () => {
    for (let index = 0; index < 9; index++) {
      const bytes = pngFor(`fresh-${index}`);
      ensureNotificationAvatarFile(userDataDir, bytes, hashOf(bytes));
    }

    expect(readdirSync(avatarDir())).toHaveLength(9);
  });

  test("sweeps a staging file a crashed write left behind", () => {
    ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    const staging = path.join(avatarDir(), `${HASH}.png.123.tmp`);
    writeFileSync(staging, Buffer.from([1, 2, 3]));
    age(staging);

    const other = pngFor("b");
    ensureNotificationAvatarFile(userDataDir, other, hashOf(other));

    expect(readdirSync(avatarDir()).sort()).toEqual(
      [`${HASH}.png`, `${hashOf(other)}.png`].sort(),
    );
  });

  test("rejects a hash that is not lowercase hex", () => {
    for (const hash of [
      "",
      "abc",
      HASH.toUpperCase(),
      `${HASH}0`,
      "../../escape",
    ]) {
      expect(() =>
        ensureNotificationAvatarFile(userDataDir, PNG, hash),
      ).toThrow("64 lowercase hex characters");
    }
    expect(readdirSync(userDataDir)).toEqual([]);
  });
});
