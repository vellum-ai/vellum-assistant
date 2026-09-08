import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureNotificationAvatarFile } from "./notification-avatar-file";

const hashOf = (seed: string): string =>
  new Bun.CryptoHasher("sha256").update(seed).digest("hex");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let userDataDir: string;

const avatarDir = (): string => path.join(userDataDir, "notification-avatars");

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-avatar-file-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("ensureNotificationAvatarFile", () => {
  test("writes the PNG under the hash and returns its absolute path", () => {
    const hash = hashOf("a");

    const file = ensureNotificationAvatarFile(userDataDir, PNG, hash);

    expect(file).toBe(path.join(avatarDir(), `${hash}.png`));
    expect(path.isAbsolute(file)).toBe(true);
    expect(readFileSync(file)).toEqual(PNG);
  });

  test("leaves an already-written avatar alone", () => {
    const hash = hashOf("a");
    const file = ensureNotificationAvatarFile(userDataDir, PNG, hash);
    writeFileSync(file, Buffer.from([1, 2, 3]));

    expect(ensureNotificationAvatarFile(userDataDir, PNG, hash)).toBe(file);
    expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
  });

  test("prunes the directory to the eight newest avatars", () => {
    const written = Array.from({ length: 8 }, (_unused, index) => {
      const hash = hashOf(`avatar-${index}`);
      const file = ensureNotificationAvatarFile(userDataDir, PNG, hash);
      // Oldest first, so the pruning order is not left to write timing.
      const seconds = 1_700_000_000 + index;
      utimesSync(file, seconds, seconds);
      return { hash, file };
    });

    const newest = hashOf("avatar-8");
    ensureNotificationAvatarFile(userDataDir, PNG, newest);

    expect(readdirSync(avatarDir()).sort()).toEqual(
      [
        ...written.slice(1).map((entry) => `${entry.hash}.png`),
        `${newest}.png`,
      ].sort(),
    );
  });

  test("rejects a hash that is not lowercase hex", () => {
    for (const hash of [
      "",
      "abc",
      hashOf("a").toUpperCase(),
      `${hashOf("a")}0`,
      "../../escape",
    ]) {
      expect(() =>
        ensureNotificationAvatarFile(userDataDir, PNG, hash),
      ).toThrow("64 lowercase hex characters");
    }
    expect(readdirSync(userDataDir)).toEqual([]);
  });
});
