/**
 * Read-only reader for the assistant's credential stores.
 *
 * Resolution order:
 * 1. CES HTTP API (when CES_CREDENTIAL_URL is set)
 * 2. Encrypted-at-rest file (~/.vellum/protected/keys.enc)
 */

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { credentialKey } from "./credential-key.js";
import { getLogger } from "./logger.js";
import { getGatewaySecurityDir, getWorkspaceDir } from "./paths.js";

export { getGatewaySecurityDir, getRootDir, getWorkspaceDir } from "./paths.js";

const log = getLogger("credential-reader");

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

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

const STORE_KEY_FILENAME = "store.key";

function getPlatformName(): string {
  // Must match assistant/src/util/platform.ts#getPlatformName exactly.
  // Using user-friendly labels like "macOS" here changes PBKDF2 entropy and
  // makes gateway unable to decrypt credentials written by the daemon.
  return process.platform;
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

/**
 * Read the v2 store key file (~/.vellum/protected/store.key).
 * Returns null if the file doesn't exist or isn't exactly 32 bytes.
 */
function readStoreKey(): Buffer | null {
  const keyPath = join(getGatewaySecurityDir(), STORE_KEY_FILENAME);
  if (!existsSync(keyPath)) return null;
  try {
    const buf = readFileSync(keyPath);
    if (buf.length !== KEY_LENGTH) return null;
    return buf;
  } catch {
    return null;
  }
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

  if (parsed.version === 2 && typeof parsed.entries === "object") {
    const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
    Object.assign(safeEntries, parsed.entries);
    parsed.entries = safeEntries;
    return parsed as StoreFileV2;
  }

  if (
    parsed.version === 1 &&
    typeof parsed.salt === "string" &&
    typeof parsed.entries === "object"
  ) {
    const safeEntries: Record<string, EncryptedEntry> = Object.create(null);
    Object.assign(safeEntries, parsed.entries);
    parsed.entries = safeEntries;
    return parsed as StoreFileV1;
  }

  throw new Error("Encrypted store has invalid format");
}

export function getEncryptedStorePath(): string {
  return join(getGatewaySecurityDir(), "keys.enc");
}

export function getMetadataPath(): string {
  return join(getWorkspaceDir(), "data", "credentials", "metadata.json");
}

// ---------------------------------------------------------------------------
// Encrypted store reader
// ---------------------------------------------------------------------------

/**
 * Read a single credential from the encrypted store.
 * Returns `undefined` if the store doesn't exist, the key is missing,
 * or decryption fails.
 *
 * For v2 stores, uses the store.key file directly as the AES key.
 * For v1 stores, derives the key from machine entropy via PBKDF2.
 */
function readEncryptedCredential(account: string): string | undefined {
  try {
    const store = readStore(getEncryptedStorePath());
    if (!store) return undefined;

    const entry = store.entries[account];
    if (!entry) return undefined;

    let key: Buffer;
    if (store.version === 2) {
      const storeKey = readStoreKey();
      if (!storeKey) return undefined;
      key = storeKey;
    } else {
      const salt = Buffer.from(store.salt, "hex");
      key = deriveKey(salt);
    }
    return decrypt(entry, key);
  } catch (err) {
    log.debug({ err, account }, "Failed to read from encrypted store");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CES HTTP credential reader (containerized mode)
// ---------------------------------------------------------------------------

const CES_HTTP_TIMEOUT_MS = 5_000;

/**
 * Try to read a credential from the CES managed service over HTTP.
 *
 * Activated when `CES_CREDENTIAL_URL` is set (e.g. `http://ces-host:8090`).
 * Requires `CES_SERVICE_TOKEN` for bearer auth.
 *
 * Returns `undefined` if the env vars are not set, the CES is unreachable,
 * or the credential doesn't exist (404).
 */
async function readCesCredential(account: string): Promise<string | undefined> {
  const baseUrl = process.env.CES_CREDENTIAL_URL?.trim();
  if (!baseUrl) return undefined;

  const serviceToken = process.env.CES_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    log.warn("CES_CREDENTIAL_URL is set but CES_SERVICE_TOKEN is missing");
    return undefined;
  }

  const url = `${baseUrl}/v1/credentials/${encodeURIComponent(account)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CES_HTTP_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (resp.status === 404) return undefined;

    if (!resp.ok) {
      log.warn(
        { account, status: resp.status },
        "CES credential read returned non-OK status",
      );
      return undefined;
    }

    const body = (await resp.json()) as { account?: string; value?: string };
    if (typeof body.value === "string") return body.value;

    log.debug({ account }, "CES credential response missing 'value' field");
    return undefined;
  } catch (err) {
    log.debug({ err, account }, "Failed to read credential from CES");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public credential reader — tries CES, then encrypted store
// ---------------------------------------------------------------------------

/**
 * Read a single credential by account key.
 *
 * Resolution order:
 * 1. CES HTTP API (when CES_CREDENTIAL_URL is set)
 * 2. Encrypted-at-rest store (keys.enc)
 */
export async function readCredential(
  account: string,
): Promise<string | undefined> {
  // CES HTTP backend (containerized mode)
  const cesValue = await readCesCredential(account);
  if (cesValue !== undefined) return cesValue;

  // Encrypted file fallback
  return readEncryptedCredential(account);
}

export type ServiceCredentialSpec = {
  /** Service name as it appears in metadata.json (e.g., "telegram", "slack_channel") */
  service: string;
  /** Field names required for this service (e.g., ["bot_token", "webhook_secret"]) */
  requiredFields: readonly string[];
};

/**
 * Generic credential reader that checks metadata for the given service and
 * reads the required fields from the encrypted store.
 *
 * Returns a `Record<string, string>` mapping field names to their values if
 * all required fields are present in metadata and readable from the store.
 * Returns `null` if metadata is missing, any required field is absent from
 * metadata, or any secret value can't be read.
 */
export async function readServiceCredentials(
  spec: ServiceCredentialSpec,
): Promise<Record<string, string> | null> {
  try {
    const metadataPath = getMetadataPath();
    if (!existsSync(metadataPath)) return null;

    const raw = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.credentials)) return null;

    // Check that all required fields exist in metadata
    for (const field of spec.requiredFields) {
      const found = data.credentials.some(
        (c: { service?: string; field?: string }) =>
          c.service === spec.service && c.field === field,
      );
      if (!found) return null;
    }

    // Read each credential from the store
    const result: Record<string, string> = {};
    for (const field of spec.requiredFields) {
      const value = await readCredential(credentialKey(spec.service, field));
      if (!value) {
        log.warn(
          `${spec.service} credential metadata exists but secrets could not be read`,
        );
        return null;
      }
      result[field] = value;
    }

    return result;
  } catch (err) {
    log.debug({ err }, `Failed to read ${spec.service} credentials`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-service credential specs
// ---------------------------------------------------------------------------

export const TELEGRAM_CREDENTIAL_SPEC: ServiceCredentialSpec = {
  service: "telegram",
  requiredFields: ["bot_token", "webhook_secret"],
} as const;

export const TWILIO_CREDENTIAL_SPEC: ServiceCredentialSpec = {
  service: "twilio",
  requiredFields: ["account_sid", "auth_token"],
} as const;

export const WHATSAPP_CREDENTIAL_SPEC: ServiceCredentialSpec = {
  service: "whatsapp",
  requiredFields: [
    "phone_number_id",
    "access_token",
    "app_secret",
    "webhook_verify_token",
  ],
} as const;

export const SLACK_CHANNEL_CREDENTIAL_SPEC: ServiceCredentialSpec = {
  service: "slack_channel",
  requiredFields: ["bot_token", "app_token"],
} as const;

export const VELLUM_CREDENTIAL_SPEC: ServiceCredentialSpec = {
  service: "vellum",
  requiredFields: [
    "platform_base_url",
    "assistant_api_key",
    "platform_assistant_id",
    "webhook_secret",
  ],
} as const;

export const ALL_CREDENTIAL_SPECS: readonly ServiceCredentialSpec[] = [
  TELEGRAM_CREDENTIAL_SPEC,
  TWILIO_CREDENTIAL_SPEC,
  WHATSAPP_CREDENTIAL_SPEC,
  SLACK_CHANNEL_CREDENTIAL_SPEC,
  VELLUM_CREDENTIAL_SPEC,
];
