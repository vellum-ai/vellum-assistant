/**
 * CES-native SecureKeyBackend for **local mode only**.
 *
 * In local mode, CES runs as a child process of the assistant on the same
 * machine as the same user and can read/write the assistant's encrypted key
 * store file at `<vellumRoot>/protected/keys.enc`.
 *
 * This implementation replicates the encryption/decryption logic from the
 * assistant's `encrypted-store.ts` without importing assistant-internal
 * modules. Writes are needed for OAuth token refresh — when CES refreshes
 * an expired access token, the new token must be persisted back to the
 * encrypted store so subsequent reads (by both CES and the assistant)
 * see the updated value.
 *
 * The encrypted store uses AES-256-GCM with a key derived from machine-
 * specific entropy via PBKDF2. The derivation includes `userInfo().username`
 * and `userInfo().homedir`, so the key is only correct when CES runs as the
 * same OS user as the assistant.
 *
 * **This backend must NOT be used in managed mode.** In managed (sidecar)
 * deployments, the assistant container runs as `root` while the CES
 * container runs as `ces` (uid 1001). The different user identity produces
 * a different PBKDF2-derived key, causing silent decryption failures.
 * Managed deployments must use `platform_oauth` handles exclusively.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Constants (must match assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // bytes (256 bits)
const IV_LENGTH = 16; // bytes (128 bits)
const AUTH_TAG_LENGTH = 16; // bytes
const PBKDF2_ITERATIONS =
  process.env.BUN_TEST === "1" ? 1 : 100_000;

// ---------------------------------------------------------------------------
// On-disk format (must match assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

interface StoreFileV1 {
  version: 1;
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

interface StoreFileV2 {
  version: 2;
  entries: Record<string, EncryptedEntry>;
}

type StoreFile = StoreFileV1 | StoreFileV2;

// ---------------------------------------------------------------------------
// Store key file (v2 format)
// ---------------------------------------------------------------------------

const STORE_KEY_FILENAME = "store.key";

/**
 * Read the v2 store key file from `<vellumRoot>/protected/store.key`.
 * Returns the raw 32-byte key buffer, or null if the file is missing,
 * wrong size, or unreadable.
 */
function readStoreKey(vellumRoot: string): Buffer | null {
  try {
    const keyPath = join(vellumRoot, "protected", STORE_KEY_FILENAME);
    if (!existsSync(keyPath)) return null;
    const buf = readFileSync(keyPath);
    if (buf.length !== KEY_LENGTH) return null;
    return buf;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Machine entropy (must match assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

function getMachineEntropy(): string {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(process.platform);
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

function deriveKey(salt: Buffer, entropyOverride?: string): Buffer {
  const entropy = entropyOverride ?? getMachineEntropy();
  return pbkdf2Sync(entropy, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, "hex");
  const tag = Buffer.from(entry.tag, "hex");
  const data = Buffer.from(entry.data, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf-8");
}

function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Store writer
// ---------------------------------------------------------------------------

function writeStore(store: StoreFile, storePath: string): void {
  const protectedDir = dirname(storePath);
  mkdirSync(protectedDir, { recursive: true });
  // Atomic write: write to temp file then rename to avoid partial/corrupt writes.
  const tmpPath = storePath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, storePath);
}

// ---------------------------------------------------------------------------
// Store reader
// ---------------------------------------------------------------------------

function readStore(storePath: string): StoreFile | null {
  try {
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.entries !== "object") return null;

    if (parsed.version === 1 && typeof parsed.salt === "string") {
      return parsed as StoreFileV1;
    }
    if (parsed.version === 2) {
      return parsed as StoreFileV2;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

/**
 * Create a SecureKeyBackend backed by the assistant's encrypted key store.
 *
 * Supports `get` and `set` operations. `set` is needed for persisting
 * refreshed OAuth tokens. `delete` remains unsupported (returns "error")
 * because CES never needs to remove keys.
 *
 * @param vellumRoot - The Vellum root directory (e.g. `~/.vellum`).
 * @param options.entropyOverride - If provided, used instead of local
 *   machine entropy for key derivation. In managed mode the CES sidecar
 *   runs in a different container with a different hostname/user, so it
 *   must use the assistant's entropy (read from the shared data mount)
 *   to derive the same AES key.
 * @param options.entropyGetter - If provided, called on each `get()`/`set()`
 *   to lazily resolve entropy. This handles the startup race where the
 *   entropy file may not exist at construction time but appears later.
 *   Takes precedence over `entropyOverride`.
 */
export function createLocalSecureKeyBackend(
  vellumRoot: string,
  options?: { entropyOverride?: string; entropyGetter?: () => string | undefined },
): SecureKeyBackend {
  const storePath = join(vellumRoot, "protected", "keys.enc");
  const staticEntropy = options?.entropyOverride;
  const entropyGetter = options?.entropyGetter;

  return {
    async get(key: string): Promise<string | undefined> {
      try {
        const store = readStore(storePath);
        if (!store) return undefined;

        const entry = store.entries[key];
        if (!entry) return undefined;

        let aesKey: Buffer;
        if (store.version === 2) {
          const storeKey = readStoreKey(vellumRoot);
          if (!storeKey) return undefined;
          aesKey = storeKey;
        } else {
          // v1: derive key from machine entropy via PBKDF2
          const entropy = entropyGetter?.() ?? staticEntropy;
          const salt = Buffer.from(store.salt, "hex");
          aesKey = deriveKey(salt, entropy);
        }

        return decrypt(entry, aesKey);
      } catch {
        return undefined;
      }
    },

    // NOTE: read-modify-write without file locking. The atomic rename
    // (writeStore) prevents corruption from partial writes, but concurrent
    // set() calls can lose updates. The window is small in practice because
    // CES serialises refresh via RefreshDeduplicator. File locking is a
    // future improvement.
    async set(key: string, value: string): Promise<boolean> {
      try {
        const store = readStore(storePath);
        if (!store) return false;

        let aesKey: Buffer;
        if (store.version === 2) {
          const storeKey = readStoreKey(vellumRoot);
          if (!storeKey) return false;
          aesKey = storeKey;
        } else {
          // v1: derive key from machine entropy via PBKDF2
          const entropy = entropyGetter?.() ?? staticEntropy;
          const salt = Buffer.from(store.salt, "hex");
          aesKey = deriveKey(salt, entropy);
        }

        store.entries[key] = encrypt(value, aesKey);
        writeStore(store, storePath);
        return true;
      } catch {
        return false;
      }
    },

    // CES never deletes keys — only reads and writes (for token refresh).
    async delete(_key: string): Promise<SecureKeyDeleteResult> {
      return "error";
    },

    async list(): Promise<string[]> {
      try {
        const store = readStore(storePath);
        if (!store) return [];
        return Object.keys(store.entries);
      } catch {
        return [];
      }
    },
  };
}
