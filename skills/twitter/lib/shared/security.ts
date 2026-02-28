/**
 * Minimal secure key retrieval for the Twitter skill.
 *
 * Reads OAuth tokens from the Vellum encrypted store (~/.vellum/protected/keys.enc)
 * without depending on the assistant's security modules. This is a read-only,
 * self-contained implementation that supports getSecureKey and withValidToken.
 *
 * The encrypted store uses AES-256-GCM with PBKDF2-derived keys from machine entropy.
 */

import {
  createDecipheriv,
  pbkdf2Sync,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Store format (matches assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

interface EncryptedEntry {
  iv: string;   // hex
  tag: string;  // hex
  data: string; // hex
}

interface StoreFile {
  version: 1;
  salt: string; // hex
  entries: Record<string, EncryptedEntry>;
}

// ---------------------------------------------------------------------------
// Paths & key derivation
// ---------------------------------------------------------------------------

const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim();
  return join(base || (userInfo().homedir || process.env.HOME || '/tmp'), '.vellum');
}

function getStorePath(): string {
  return join(getRootDir(), 'protected', 'keys.enc');
}

function getMachineEntropy(): string {
  const parts: string[] = [];
  try { parts.push(hostname()); } catch { parts.push('unknown-host'); }
  try { parts.push(userInfo().username); } catch { parts.push('unknown-user'); }
  parts.push(process.platform);
  parts.push(process.arch);
  try { parts.push(userInfo().homedir); } catch { parts.push('/tmp'); }
  return parts.join(':');
}

function deriveKey(salt: Buffer): Buffer {
  return pbkdf2Sync(getMachineEntropy(), salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, 'hex');
  const tag = Buffer.from(entry.tag, 'hex');
  const data = Buffer.from(entry.data, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a secret from the Vellum encrypted store.
 * Returns undefined if the store doesn't exist, the key is missing, or decryption fails.
 */
export function getSecureKey(account: string): string | undefined {
  try {
    const path = getStorePath();
    if (!existsSync(path)) return undefined;

    const store = JSON.parse(readFileSync(path, 'utf-8')) as StoreFile;
    if (store.version !== 1 || !store.salt || !store.entries) return undefined;

    const entry = store.entries[account];
    if (!entry) return undefined;

    const salt = Buffer.from(store.salt, 'hex');
    const key = deriveKey(salt);
    return decrypt(entry, key);
  } catch {
    return undefined;
  }
}

/**
 * Execute a callback with a valid OAuth access token.
 *
 * Simplified version: reads the stored token and passes it to the callback.
 * Does not handle proactive refresh or 401 retry — if the token is expired,
 * the caller should prompt the user to re-authenticate via the daemon.
 */
export async function withValidToken<T>(
  service: string,
  callback: (token: string) => Promise<T>,
): Promise<T> {
  const token = getSecureKey(`credential:${service}:access_token`);
  if (!token) {
    throw new Error(`No access token found for "${service}". Authorization required.`);
  }
  return callback(token);
}
