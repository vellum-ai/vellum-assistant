/**
 * Read-only reader for the assistant's encrypted credential store.
 *
 * Reads credentials from the encrypted-at-rest file
 * (<instanceDir>/.vellum/protected/keys.enc). Uses the same AES-256-GCM
 * encryption and PBKDF2 key derivation as the assistant daemon and gateway.
 */

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

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
  return pbkdf2Sync(
    getMachineEntropy(),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha512",
  );
}

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

/**
 * Read a credential from the encrypted store for a given instance directory.
 *
 * @param instanceDir - The assistant instance directory (e.g. ~/.vellum or a per-instance dir)
 * @param account - The credential key (e.g. "credential/bootstrapped_actor/http_token")
 * @returns The decrypted credential value, or undefined if not found or decryption fails.
 */
export function readCredential(
  instanceDir: string,
  account: string,
): string | undefined {
  try {
    const storePath = join(instanceDir, ".vellum", "protected", "keys.enc");
    if (!existsSync(storePath)) return undefined;

    const raw = readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as StoreFile;
    if (
      store.version !== 1 ||
      typeof store.salt !== "string" ||
      typeof store.entries !== "object"
    )
      return undefined;

    const entry = store.entries[account];
    if (!entry) return undefined;

    const salt = Buffer.from(store.salt, "hex");
    const key = deriveKey(salt);
    return decrypt(entry, key);
  } catch {
    return undefined;
  }
}
