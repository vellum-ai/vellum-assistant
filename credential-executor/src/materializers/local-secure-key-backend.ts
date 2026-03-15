/**
 * CES-native read-only SecureKeyBackend for local mode.
 *
 * In local mode, CES runs as a child process of the assistant on the same
 * machine and can read the assistant's encrypted key store file at
 * `<vellumRoot>/protected/keys.enc`.
 *
 * This implementation replicates the decryption logic from the assistant's
 * `encrypted-store.ts` without importing assistant-internal modules. It is
 * intentionally **read-only** — CES never writes or deletes keys in the
 * assistant's key store. The `set` and `delete` methods return failure to
 * enforce this invariant.
 *
 * The encrypted store uses AES-256-GCM with a key derived from machine-
 * specific entropy via PBKDF2. Since CES runs on the same machine as the
 * same user, the derived key is identical.
 */

import {
  createDecipheriv,
  pbkdf2Sync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Constants (must match assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // bytes (256 bits)
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

interface StoreFile {
  version: 1;
  salt: string;
  entries: Record<string, EncryptedEntry>;
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

function deriveKey(salt: Buffer): Buffer {
  const entropy = getMachineEntropy();
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

// ---------------------------------------------------------------------------
// Store reader
// ---------------------------------------------------------------------------

function readStore(storePath: string): StoreFile | null {
  try {
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed.version !== 1 ||
      typeof parsed.salt !== "string" ||
      typeof parsed.entries !== "object"
    ) {
      return null;
    }
    return parsed as StoreFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

/**
 * Create a read-only SecureKeyBackend that reads from the assistant's
 * encrypted key store.
 *
 * @param vellumRoot - The Vellum root directory (e.g. `~/.vellum`).
 */
export function createLocalSecureKeyBackend(
  vellumRoot: string,
): SecureKeyBackend {
  const storePath = join(vellumRoot, "protected", "keys.enc");

  return {
    async get(key: string): Promise<string | undefined> {
      try {
        const store = readStore(storePath);
        if (!store) return undefined;

        const entry = store.entries[key];
        if (!entry) return undefined;

        const salt = Buffer.from(store.salt, "hex");
        const derivedKey = deriveKey(salt);
        return decrypt(entry, derivedKey);
      } catch {
        return undefined;
      }
    },

    // CES never writes to the assistant's key store — read-only backend.
    async set(_key: string, _value: string): Promise<boolean> {
      return false;
    },

    // CES never deletes from the assistant's key store — read-only backend.
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
