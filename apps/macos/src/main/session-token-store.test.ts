import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Only `electron` is stubbed (no Electron runtime / keychain in tests). The
// store's fs calls run against a real per-test temp dir, so the file, its mode,
// and real ENOENT/round-trip behavior are exercised for real.

let userDataDir = "";
let encryptionAvailable = true;

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    // Reversible tag so round-trips and bad blobs are checkable.
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (blob: Buffer) => {
      const text = blob.toString();
      if (!text.startsWith("enc:")) throw new Error("undecryptable blob");
      return text.slice("enc:".length);
    },
  },
}));

mock.module("./logger", () => ({ default: { warn: () => {}, error: () => {} } }));

const { getSessionToken, saveSessionToken, clearSessionToken } = await import(
  "./session-token-store"
);

const tokenPath = (): string => path.join(userDataDir, "session.enc");

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), "vellum-session-token-"));
  encryptionAvailable = true;
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("saveSessionToken", () => {
  test("writes an encrypted, 0600 file that getSessionToken round-trips", () => {
    saveSessionToken("tok-abc");

    expect(getSessionToken()).toBe("tok-abc");
    expect(readFileSync(tokenPath()).toString()).toBe("enc:tok-abc");
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  });

  test("does not persist when encryption is unavailable", () => {
    encryptionAvailable = false;

    saveSessionToken("tok-abc");

    expect(existsSync(tokenPath())).toBe(false);
  });
});

describe("getSessionToken", () => {
  test("returns null when no file exists (signed out)", () => {
    expect(getSessionToken()).toBeNull();
  });

  test("returns null for an undecryptable blob without throwing", () => {
    writeFileSync(tokenPath(), "garbage-not-encrypted");

    expect(() => getSessionToken()).not.toThrow();
    expect(getSessionToken()).toBeNull();
  });

  test("returns null when encryption is unavailable even if a file exists", () => {
    writeFileSync(tokenPath(), "enc:persisted-tok");
    encryptionAvailable = false;

    expect(getSessionToken()).toBeNull();
  });
});

describe("clearSessionToken", () => {
  test("deletes the persisted file", () => {
    saveSessionToken("tok-abc");

    clearSessionToken();

    expect(existsSync(tokenPath())).toBe(false);
    expect(getSessionToken()).toBeNull();
  });

  test("tolerates a missing file", () => {
    expect(() => clearSessionToken()).not.toThrow();
  });
});
