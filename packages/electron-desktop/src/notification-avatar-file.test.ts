import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
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

/** A cache entry as an earlier run of the app left it, unknown to this one. */
const seedCacheEntry = (bytes: Buffer): string => {
  mkdirSync(avatarDir(), { recursive: true });
  const file = path.join(avatarDir(), `${HASH}.png`);
  writeFileSync(file, bytes);
  return file;
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

  test("rewrites a cache entry whose bytes hash to something else", () => {
    const impostor = pngFor("b");
    expect(impostor.length).toBe(PNG.length);
    const file = seedCacheEntry(impostor);

    expect(ensureNotificationAvatarFile(userDataDir, PNG, HASH)).toBe(file);
    expect(readFileSync(file)).toEqual(PNG);
  });

  test("reads a cache entry for its digest once per process", () => {
    const file = seedCacheEntry(PNG);
    ensureNotificationAvatarFile(userDataDir, PNG, HASH);

    // The digest guards a file this process found on disk, not one changed
    // under it, so a verified entry is served without being read again.
    const impostor = pngFor("b");
    writeFileSync(file, impostor);
    ensureNotificationAvatarFile(userDataDir, PNG, HASH);

    expect(readFileSync(file)).toEqual(impostor);
  });

  test("re-reads an avatar the prune removed before serving it again", () => {
    const file = seedCacheEntry(PNG);
    ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    age(file);
    for (let index = 0; index < 16; index++) {
      const bytes = pngFor(`avatar-${index}`);
      age(
        ensureNotificationAvatarFile(userDataDir, bytes, hashOf(bytes)),
        index + 1,
      );
    }
    expect(existsSync(file)).toBe(false);

    seedCacheEntry(pngFor("b"));

    expect(ensureNotificationAvatarFile(userDataDir, PNG, HASH)).toBe(file);
    expect(readFileSync(file)).toEqual(PNG);
  });

  test("prunes the aged directory to the sixteen newest avatars", () => {
    const written = Array.from({ length: 16 }, (_unused, index) => {
      const bytes = pngFor(`avatar-${index}`);
      const hash = hashOf(bytes);
      // Oldest first, and all past the prune floor, so the pruning order is
      // not left to write timing.
      age(ensureNotificationAvatarFile(userDataDir, bytes, hash), index);
      return hash;
    });

    const newest = pngFor("avatar-16");
    ensureNotificationAvatarFile(userDataDir, newest, hashOf(newest));

    expect(readdirSync(avatarDir()).sort()).toEqual(
      [
        ...written.slice(1).map((hash) => `${hash}.png`),
        `${hashOf(newest)}.png`,
      ].sort(),
    );
  });

  test("keeps avatars past the cap while a toast could still be reading them", () => {
    for (let index = 0; index < 17; index++) {
      const bytes = pngFor(`fresh-${index}`);
      ensureNotificationAvatarFile(userDataDir, bytes, hashOf(bytes));
    }

    expect(readdirSync(avatarDir())).toHaveLength(17);
  });

  test("keeps the avatar it just wrote when the prune cannot remove a file", () => {
    ensureNotificationAvatarFile(userDataDir, PNG, HASH);
    // A directory under a staging name: the sweep tries to remove it and the
    // non-recursive `rmSync` throws, which must not cost the new avatar.
    const blocked = path.join(avatarDir(), `${HASH}.png.123.tmp`);
    mkdirSync(blocked);
    age(blocked);

    const other = pngFor("b");
    const file = ensureNotificationAvatarFile(
      userDataDir,
      other,
      hashOf(other),
    );

    expect(readFileSync(file)).toEqual(other);
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

  test("rejects a well-formed hash that is not the digest of the bytes", () => {
    // The hash names the file every later notification is served from, so a
    // picture filed under another one's name would be shown as that assistant.
    expect(() =>
      ensureNotificationAvatarFile(userDataDir, PNG, hashOf(pngFor("b"))),
    ).toThrow("match its bytes");
    expect(readdirSync(userDataDir)).toEqual([]);
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
