import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  decryptFile,
  ENCRYPTED_HEADER_SIZE,
  encryptFile,
  GCM_TAG_SIZE,
  verifyEncryptedFile,
} from "../stream-crypt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = join(
    tmpdir(),
    `vellum-stream-crypt-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function makeKey(seed: number): Buffer {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = (seed + i) & 0xff;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stream-crypt", () => {
  test("round-trips a 1 KB random file", async () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(1024);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");
    const roundTripPath = join(TEST_DIR, "roundtrip.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPath, key);
    await decryptFile(encPath, roundTripPath, key);

    const result = readFileSync(roundTripPath);
    expect(result.equals(plaintext)).toBe(true);

    // Encrypted file has the IV + tag overhead
    const encBytes = readFileSync(encPath);
    expect(encBytes.length).toBe(
      plaintext.length + ENCRYPTED_HEADER_SIZE + GCM_TAG_SIZE,
    );
  });

  test("round-trips a 10 MB file (streaming across chunk boundaries)", async () => {
    const key = randomBytes(32);
    const size = 10 * 1024 * 1024;
    const plaintext = randomBytes(size);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");
    const roundTripPath = join(TEST_DIR, "roundtrip.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPath, key);
    await decryptFile(encPath, roundTripPath, key);

    const result = readFileSync(roundTripPath);
    expect(result.length).toBe(size);
    expect(result.equals(plaintext)).toBe(true);
  });

  test("auth tag verification: flipping a byte in the ciphertext causes decrypt to throw", async () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(2048);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");
    const outPath = join(TEST_DIR, "out.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPath, key);

    // Flip one byte somewhere in the middle of the ciphertext body
    // (not in the IV header or the trailing auth tag).
    const ciphertextByteOffset =
      ENCRYPTED_HEADER_SIZE + Math.floor(plaintext.length / 2);
    const fh = await open(encPath, "r+");
    try {
      const one = Buffer.alloc(1);
      await fh.read(one, 0, 1, ciphertextByteOffset);
      one[0] = one[0] ^ 0xff;
      await fh.write(one, 0, 1, ciphertextByteOffset);
    } finally {
      await fh.close();
    }

    await expect(decryptFile(encPath, outPath, key)).rejects.toThrow();
  });

  test("decrypting with the wrong key throws", async () => {
    const keyA = makeKey(1);
    const keyB = makeKey(99);
    const plaintext = randomBytes(4096);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");
    const outPath = join(TEST_DIR, "out.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPath, keyA);

    await expect(decryptFile(encPath, outPath, keyB)).rejects.toThrow();
  });

  test("passing a 16-byte key throws the typed error", async () => {
    const badKey = randomBytes(16);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");

    writeFileSync(plainPath, Buffer.from("hello world", "utf-8"));

    await expect(encryptFile(plainPath, encPath, badKey)).rejects.toThrow(
      "Backup encryption key must be 32 bytes",
    );
  });

  test("IV uniqueness: encrypting the same file twice yields different outputs", async () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(4096);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPathA = join(TEST_DIR, "enc-a.bin");
    const encPathB = join(TEST_DIR, "enc-b.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPathA, key);
    await encryptFile(plainPath, encPathB, key);

    const a = readFileSync(encPathA);
    const b = readFileSync(encPathB);

    expect(a.equals(b)).toBe(false);
    // The first 12 bytes are the IV — they must differ with overwhelming
    // probability (collision chance is 1/2^96 for random 12-byte IVs).
    expect(
      a.subarray(0, ENCRYPTED_HEADER_SIZE).equals(
        b.subarray(0, ENCRYPTED_HEADER_SIZE),
      ),
    ).toBe(false);
  });

  test("verifyEncryptedFile returns true for a valid bundle and false for a tampered one", async () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(1024);
    const plainPath = join(TEST_DIR, "plain.bin");
    const encPath = join(TEST_DIR, "enc.bin");

    writeFileSync(plainPath, plaintext);
    await encryptFile(plainPath, encPath, key);

    expect(await verifyEncryptedFile(encPath, key)).toBe(true);

    // Tamper the ciphertext and re-verify
    const fh = await open(encPath, "r+");
    try {
      const flipOffset = ENCRYPTED_HEADER_SIZE + 10;
      const one = Buffer.alloc(1);
      await fh.read(one, 0, 1, flipOffset);
      one[0] = one[0] ^ 0x01;
      await fh.write(one, 0, 1, flipOffset);
    } finally {
      await fh.close();
    }

    expect(await verifyEncryptedFile(encPath, key)).toBe(false);
  });
});
