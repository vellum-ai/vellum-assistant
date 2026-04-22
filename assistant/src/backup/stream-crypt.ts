/**
 * Streaming AES-256-GCM file encryption/decryption for backup bundles.
 *
 * The on-disk format is:
 *
 *   [12-byte IV][ciphertext...][16-byte GCM auth tag]
 *
 * Both encrypt and decrypt use Node streams so peak memory stays bounded
 * regardless of input size. This is important for backup archives which may
 * run to many gigabytes on larger workspaces.
 *
 * The key must be exactly 32 bytes (AES-256). The IV is randomly generated
 * per call, which is required for GCM semantic security — never reuse an
 * IV with the same key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Size of the AES-GCM initialization vector prefix, in bytes. */
export const ENCRYPTED_HEADER_SIZE = 12;

/** Size of the AES-GCM authentication tag suffix, in bytes. */
export const GCM_TAG_SIZE = 16;

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error("Backup encryption key must be 32 bytes");
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup — swallow ENOENT and other errors
  }
}

function tempPath(outputPath: string): string {
  return `${outputPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Stream-encrypt `inputPath` to `outputPath` using AES-256-GCM.
 *
 * Produces `[IV (12 bytes)][ciphertext][auth tag (16 bytes)]` in the output.
 * Writes to a temp file and atomically renames on success; unlinks the temp
 * file on any error so failed writes don't leave partial bundles behind.
 */
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  key: Buffer,
): Promise<void> {
  assertKey(key);

  const iv = randomBytes(ENCRYPTED_HEADER_SIZE);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const tmp = tempPath(outputPath);
  const writeStream = createWriteStream(tmp);

  try {
    // Write IV first so decrypt can read it without knowing the ciphertext size.
    await new Promise<void>((resolve, reject) => {
      writeStream.write(iv, (err) => (err ? reject(err) : resolve()));
    });

    // Stream plaintext through the cipher into the output.
    const readStream = createReadStream(inputPath);
    await pipeline(readStream, cipher, writeStream, { end: false });

    // Append the auth tag after the ciphertext body.
    const tag = cipher.getAuthTag();
    await new Promise<void>((resolve, reject) => {
      writeStream.write(tag, (err) => (err ? reject(err) : resolve()));
    });

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    await rename(tmp, outputPath);
  } catch (err) {
    // Make sure the write stream is closed before we try to unlink the temp file.
    writeStream.destroy();
    await safeUnlink(tmp);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Stream-decrypt `inputPath` to `outputPath`. Expects the on-disk format
 * produced by `encryptFile`: `[IV][ciphertext][auth tag]`.
 *
 * Reads the IV and auth tag via positional reads, then streams only the
 * ciphertext body through the decipher. Atomic tmp + rename semantics.
 */
export async function decryptFile(
  inputPath: string,
  outputPath: string,
  key: Buffer,
): Promise<void> {
  assertKey(key);

  const info = await stat(inputPath);
  const totalSize = info.size;
  const minSize = ENCRYPTED_HEADER_SIZE + GCM_TAG_SIZE;
  if (totalSize < minSize) {
    throw new Error(
      `Encrypted file is too small: ${totalSize} bytes (need at least ${minSize})`,
    );
  }

  // Read IV (first 12 bytes) and auth tag (last 16 bytes) via positional reads.
  const iv = Buffer.alloc(ENCRYPTED_HEADER_SIZE);
  const tag = Buffer.alloc(GCM_TAG_SIZE);
  const fh = await open(inputPath, "r");
  try {
    await fh.read(iv, 0, ENCRYPTED_HEADER_SIZE, 0);
    await fh.read(tag, 0, GCM_TAG_SIZE, totalSize - GCM_TAG_SIZE);
  } finally {
    await fh.close();
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const ciphertextStart = ENCRYPTED_HEADER_SIZE;
  const ciphertextEnd = totalSize - GCM_TAG_SIZE - 1; // createReadStream end is inclusive
  const hasCiphertext = ciphertextEnd >= ciphertextStart;

  const tmp = tempPath(outputPath);
  const writeStream = createWriteStream(tmp);

  try {
    const ciphertextStream = hasCiphertext
      ? createReadStream(inputPath, {
          start: ciphertextStart,
          end: ciphertextEnd,
        })
      : Readable.from([]);

    // pipeline consumes the ciphertext, pushes it through the decipher, and
    // calls decipher.final() at the end — which is where auth tag verification
    // happens. A bad tag surfaces here as a thrown error.
    await pipeline(ciphertextStream, decipher, writeStream);

    await rename(tmp, outputPath);
  } catch (err) {
    writeStream.destroy();
    await safeUnlink(tmp);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify that `path` is a valid AES-256-GCM encrypted bundle for `key`.
 *
 * Streams the ciphertext through the decipher into a null sink and relies on
 * `decipher.final()` to either succeed (tag matches) or throw (tamper / wrong
 * key). No scratch file is written, so a full or read-only tmpdir cannot
 * cause a healthy backup to be reported as invalid.
 *
 * Returns `true` if the bundle authenticates, `false` on a cryptographic
 * failure (bad auth tag, wrong key, truncated/short input). Filesystem errors
 * on the *source* file (ENOENT, EACCES, EIO, …) are rethrown so callers can
 * distinguish tamper from transient I/O.
 */
export async function verifyEncryptedFile(
  path: string,
  key: Buffer,
): Promise<boolean> {
  assertKey(key);

  const info = await stat(path);
  const totalSize = info.size;
  const minSize = ENCRYPTED_HEADER_SIZE + GCM_TAG_SIZE;
  if (totalSize < minSize) {
    // Too short to contain an IV + tag — not a valid bundle.
    return false;
  }

  const iv = Buffer.alloc(ENCRYPTED_HEADER_SIZE);
  const tag = Buffer.alloc(GCM_TAG_SIZE);
  const fh = await open(path, "r");
  try {
    await fh.read(iv, 0, ENCRYPTED_HEADER_SIZE, 0);
    await fh.read(tag, 0, GCM_TAG_SIZE, totalSize - GCM_TAG_SIZE);
  } finally {
    await fh.close();
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const ciphertextStart = ENCRYPTED_HEADER_SIZE;
  const ciphertextEnd = totalSize - GCM_TAG_SIZE - 1;
  const hasCiphertext = ciphertextEnd >= ciphertextStart;
  const ciphertextStream = hasCiphertext
    ? createReadStream(path, { start: ciphertextStart, end: ciphertextEnd })
    : Readable.from([]);

  // Discard-only sink — verification never touches scratch disk.
  const nullSink = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });

  try {
    await pipeline(ciphertextStream, decipher, nullSink);
    return true;
  } catch (err) {
    if (isFilesystemError(err)) {
      throw err;
    }
    return false;
  }
}

// Node errno exceptions surface as uppercase `E`-prefixed codes (ENOENT,
// EACCES, ENOSPC, EIO, EROFS, …). Crypto errors use `ERR_*` codes or no code
// at all, so the regex rules them out.
function isFilesystemError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code);
}
