/**
 * Read-only reader for the assistant's credential stores.
 *
 * The assistant persists secrets in either:
 * 1. macOS Keychain (via `security` CLI) — preferred on darwin
 * 2. Encrypted-at-rest file (~/.vellum/protected/keys.enc) — fallback
 *
 * This module tries the OS keychain first on macOS, then falls back to
 * the encrypted store, mirroring the assistant's own secure-keys module.
 */

import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("credential-reader");

/** Service name matching the assistant's keychain module. */
const KEYCHAIN_SERVICE = "vellum-assistant";

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

function getPlatformName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
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
  parts.push(getPlatformName());
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

function readStore(storePath: string): StoreFile | null {
  if (!existsSync(storePath)) return null;

  const raw = readFileSync(storePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (
    parsed.version !== 1 ||
    typeof parsed.salt !== "string" ||
    typeof parsed.entries !== "object"
  ) {
    throw new Error("Encrypted store has invalid format");
  }
  const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
  Object.assign(safeEntries, parsed.entries);
  parsed.entries = safeEntries;
  return parsed as StoreFile;
}

export function getRootDir(): string {
  return join(
    process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? "/tmp"),
    ".vellum",
  );
}

export function getEncryptedStorePath(): string {
  return join(getRootDir(), "protected", "keys.enc");
}

export function getMetadataPath(): string {
  return join(getRootDir(), "workspace", "data", "credentials", "metadata.json");
}

/**
 * Read a single credential from the macOS Keychain.
 * Returns `undefined` on non-macOS platforms, when the credential
 * doesn't exist, or on any error.
 */
export function readKeychainCredential(account: string): string | undefined {
  if (process.platform !== "darwin") return undefined;

  try {
    const result = execFileSync("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w",
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf-8",
    });
    const value = result.replace(/\n$/, "");
    if (!value) return undefined;
    log.debug({ account }, "Credential found in keychain");
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Read a single credential from the encrypted store.
 * Returns `undefined` if the store doesn't exist, the key is missing,
 * or decryption fails.
 */
export function readCredential(account: string): string | undefined {
  try {
    const store = readStore(getEncryptedStorePath());
    if (!store) return undefined;

    const entry = store.entries[account];
    if (!entry) return undefined;

    const salt = Buffer.from(store.salt, "hex");
    const key = deriveKey(salt);
    return decrypt(entry, key);
  } catch (err) {
    log.debug({ err, account }, "Failed to read from encrypted store");
    return undefined;
  }
}

export type TelegramCredentials = {
  botToken: string;
  webhookSecret: string;
};

/**
 * Read a credential by trying keychain first (on macOS), then encrypted store.
 */
function readCredentialWithFallback(account: string): string | undefined {
  const keychainValue = readKeychainCredential(account);
  if (keychainValue !== undefined) return keychainValue;

  const encValue = readCredential(account);
  if (encValue !== undefined) {
    log.debug({ account }, "Credential found in encrypted store");
  }
  return encValue;
}

/**
 * Check the credential metadata file for Telegram credentials and read
 * them from secure storage (keychain on macOS, then encrypted store).
 *
 * Returns `null` if:
 * - The metadata file doesn't exist or can't be parsed
 * - Telegram bot_token or webhook_secret entries are missing from metadata
 * - The actual secret values can't be read from any backend
 */
export function readTelegramCredentials(): TelegramCredentials | null {
  try {
    const metadataPath = getMetadataPath();
    if (!existsSync(metadataPath)) return null;

    const raw = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.credentials)) return null;

    const hasBotToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "telegram" && c.field === "bot_token",
    );
    const hasWebhookSecret = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "telegram" && c.field === "webhook_secret",
    );

    if (!hasBotToken || !hasWebhookSecret) return null;

    const botToken = readCredentialWithFallback("credential:telegram:bot_token");
    const webhookSecret = readCredentialWithFallback("credential:telegram:webhook_secret");

    if (!botToken || !webhookSecret) {
      log.warn(
        "Telegram credential metadata exists but secrets could not be read from any backend",
      );
      return null;
    }

    return { botToken, webhookSecret };
  } catch (err) {
    log.debug({ err }, "Failed to read Telegram credentials");
    return null;
  }
}
