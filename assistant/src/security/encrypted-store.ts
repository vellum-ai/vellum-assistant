/**
 * Encrypted-at-rest key storage — fallback for systems without OS keychain.
 *
 * Uses AES-256-GCM with a key derived from machine-specific entropy:
 *   - hostname, username, platform, arch, homedir
 *   - PBKDF2 with 100k iterations + a persisted random salt
 *
 * Secrets are stored in `~/.vellum/keys.enc` as a JSON blob encrypted
 * with the derived key. Each entry has its own IV for authenticated encryption.
 *
 * Provides the same get/set/delete interface as `keychain.ts`.
 */

import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { getRootDir, getPlatformName } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('encrypted-store');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes (256 bits)
const IV_LENGTH = 16; // bytes (128 bits)
const AUTH_TAG_LENGTH = 16; // bytes
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 32; // bytes

/** On-disk format for the encrypted store. */
interface StoreFile {
  /** Version for future format changes. */
  version: 1;
  /** Hex-encoded salt for PBKDF2 key derivation. */
  salt: string;
  /** Individual encrypted entries keyed by account name. */
  entries: Record<string, EncryptedEntry>;
}

/** A single encrypted value. */
interface EncryptedEntry {
  /** Hex-encoded IV. */
  iv: string;
  /** Hex-encoded auth tag. */
  tag: string;
  /** Hex-encoded ciphertext. */
  data: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let storePathOverride: string | null = null;

function getStorePath(): string {
  return storePathOverride ?? join(getRootDir(), 'protected', 'keys.enc');
}

/** @internal Test-only: override the store file path. Pass `null` to reset. */
export function _setStorePath(path: string | null): void {
  storePathOverride = path;
}

// ---------------------------------------------------------------------------
// Machine entropy for key derivation
// ---------------------------------------------------------------------------

function getMachineEntropy(): string {
  const parts: string[] = [];
  try { parts.push(hostname()); } catch { parts.push('unknown-host'); }
  try { parts.push(userInfo().username); } catch { parts.push('unknown-user'); }
  parts.push(getPlatformName());
  parts.push(process.arch);
  try { parts.push(userInfo().homedir); } catch { parts.push('/tmp'); }
  return parts.join(':');
}

function deriveKey(salt: Buffer): Buffer {
  const entropy = getMachineEntropy();
  return pbkdf2Sync(entropy, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

/**
 * Read result: distinguishes "file missing" from "file corrupt/unreadable".
 * - `null`: file does not exist (safe to create)
 * - `StoreFile`: successfully parsed
 * - throws: file exists but cannot be parsed (corrupt/invalid)
 */
function readStore(): StoreFile | null {
  const path = getStorePath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || typeof parsed.salt !== 'string' || typeof parsed.entries !== 'object') {
    throw new Error('Encrypted store has invalid format');
  }
  // Use null-prototype object for entries to prevent prototype pollution
  const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
  Object.assign(safeEntries, parsed.entries);
  parsed.entries = safeEntries;
  return parsed as StoreFile;
}

function writeStore(store: StoreFile): void {
  const path = getStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Enforce 0600 even if the file already existed with permissive bits
  chmodSync(path, 0o600);
}

function getOrCreateStore(): StoreFile {
  const path = getStorePath();
  if (existsSync(path)) {
    // File exists — must be parseable, otherwise fail to prevent data loss
    return readStore()!;
  }
  const salt = randomBytes(SALT_LENGTH);
  const entries: Record<string, EncryptedEntry> = Object.create(null);
  const store: StoreFile = {
    version: 1,
    salt: salt.toString('hex'),
    entries,
  };
  writeStore(store);
  return store;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, 'hex');
  const tag = Buffer.from(entry.tag, 'hex');
  const data = Buffer.from(entry.data, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Public API — matches keychain.ts interface
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from the encrypted store.
 * Returns `undefined` if the key doesn't exist or decryption fails.
 */
export function getKey(account: string): string | undefined {
  try {
    const store = readStore();
    if (!store) return undefined;

    const entry = store.entries[account];
    if (!entry) return undefined;

    const salt = Buffer.from(store.salt, 'hex');
    const key = deriveKey(salt);
    return decrypt(entry, key);
  } catch (err) {
    log.debug({ err, account }, 'Failed to read from encrypted store');
    return undefined;
  }
}

/**
 * Store a secret in the encrypted store.
 * Returns true on success, false on failure.
 */
export function setKey(account: string, value: string): boolean {
  try {
    const store = getOrCreateStore();
    const salt = Buffer.from(store.salt, 'hex');
    const key = deriveKey(salt);
    store.entries[account] = encrypt(value, key);
    writeStore(store);
    return true;
  } catch (err) {
    log.warn({ err, account }, 'Failed to write to encrypted store');
    return false;
  }
}

/**
 * Delete a secret from the encrypted store.
 * Returns true on success, false if not found or on failure.
 */
export function deleteKey(account: string): boolean {
  try {
    const store = readStore();
    if (!store || !Object.prototype.hasOwnProperty.call(store.entries, account)) return false;

    delete store.entries[account];
    writeStore(store);
    return true;
  } catch (err) {
    log.debug({ err, account }, 'Failed to delete from encrypted store');
    return false;
  }
}

/**
 * List all account names in the encrypted store.
 */
export function listKeys(): string[] {
  try {
    const store = readStore();
    if (!store) return [];
    return Object.keys(store.entries);
  } catch {
    return [];
  }
}
