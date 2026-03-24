/**
 * Read-only reader for the assistant's credential stores.
 *
 * Resolution order:
 * 1. CES HTTP API (when CES_CREDENTIAL_URL is set — containerized mode)
 * 2. Keychain broker (UDS — native macOS/Linux)
 * 3. Encrypted-at-rest file (~/.vellum/protected/keys.enc)
 */

import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { credentialKey } from "./credential-key.js";
import { getLogger } from "./logger.js";

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
  const keyPath = join(getRootDir(), "protected", STORE_KEY_FILENAME);
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

export function getRootDir(): string {
  return join(
    process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? "/tmp"),
    ".vellum",
  );
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When VELLUM_WORKSPACE_DIR is set, returns that value (used in containerized
 * deployments where the workspace is a separate volume). Otherwise falls back
 * to ~/.vellum/workspace.
 */
export function getWorkspaceDir(): string {
  // WORKSPACE_DIR fallback: remove after vellum-assistant-platform switches to VELLUM_WORKSPACE_DIR
  const override = (process.env.VELLUM_WORKSPACE_DIR ?? process.env.WORKSPACE_DIR)?.trim();
  if (override) return override;
  return join(getRootDir(), "workspace");
}

export function getEncryptedStorePath(): string {
  return join(getRootDir(), "protected", "keys.enc");
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
// Keychain broker reader (UDS) — native async implementation
// ---------------------------------------------------------------------------

const BROKER_TIMEOUT_MS = 5_000;

function getBrokerTokenPath(): string {
  return join(getRootDir(), "protected", "keychain-broker.token");
}

/**
 * Try to read a credential from the keychain broker over its Unix domain socket.
 * Uses a native UDS connection (no external process spawn).
 * Returns `undefined` if the broker is unavailable, the socket file doesn't exist,
 * the token file is missing, or the broker doesn't have the requested key.
 */
async function readBrokerCredential(
  account: string,
): Promise<string | undefined> {
  const socketPath = join(getRootDir(), "keychain-broker.sock");

  // Check socket file exists before attempting connection — createConnection
  // can throw synchronously in some runtimes (e.g. Bun) for ENOENT.
  if (!existsSync(socketPath)) return undefined;

  const tokenPath = getBrokerTokenPath();
  let token: string;
  try {
    if (!existsSync(tokenPath)) return undefined;
    token = readFileSync(tokenPath, "utf-8").trim();
    if (!token) return undefined;
  } catch {
    return undefined;
  }

  const reqId = randomUUID();
  const request = JSON.stringify({
    v: 1,
    id: reqId,
    method: "key.get",
    token,
    params: { account },
  });

  try {
    return await new Promise<string | undefined>((resolve) => {
      let buf = "";
      let settled = false;

      // Declare socket before the timer so the timeout closure never
      // hits a TDZ if createConnection throws synchronously.
      let socket: ReturnType<typeof createConnection> | undefined;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket?.destroy();
          } catch {
            /* already destroyed or never created */
          }
          log.debug({ account }, "Broker read timed out");
          resolve(undefined);
        }
      }, BROKER_TIMEOUT_MS);

      try {
        socket = createConnection({ path: socketPath });
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        log.debug({ err, account }, "Failed to connect to keychain broker");
        resolve(undefined);
        return;
      }

      socket.on("connect", () => {
        socket!.write(request + "\n");
      });

      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          try {
            const resp = JSON.parse(buf.slice(0, idx));
            if (
              resp.ok &&
              resp.result?.found &&
              typeof resp.result.value === "string"
            ) {
              resolve(resp.result.value);
            } else {
              resolve(undefined);
            }
          } catch {
            resolve(undefined);
          }
          socket!.destroy();
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          log.debug({ err, account }, "Failed to read from keychain broker");
          resolve(undefined);
        }
      });
    });
  } catch (err) {
    log.debug({ err, account }, "Failed to read from keychain broker");
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
async function readCesCredential(
  account: string,
): Promise<string | undefined> {
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
// Public credential reader — tries CES, broker, then encrypted store
// ---------------------------------------------------------------------------

/**
 * Read a single credential by account key.
 *
 * Resolution order:
 * 1. CES HTTP API (when CES_CREDENTIAL_URL is set)
 * 2. Keychain broker (UDS)
 * 3. Encrypted-at-rest store (keys.enc)
 */
export async function readCredential(
  account: string,
): Promise<string | undefined> {
  // CES HTTP backend (containerized mode)
  const cesValue = await readCesCredential(account);
  if (cesValue !== undefined) return cesValue;

  // Keychain broker (native mode)
  const brokerValue = await readBrokerCredential(account);
  if (brokerValue !== undefined) return brokerValue;

  // Encrypted file fallback
  return readEncryptedCredential(account);
}

export type TelegramCredentials = {
  botToken: string;
  webhookSecret: string;
};

export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
};

/**
 * Check the credential metadata file for Telegram credentials and read
 * them from the encrypted store.
 *
 * Returns `null` if:
 * - The metadata file doesn't exist or can't be parsed
 * - Telegram bot_token or webhook_secret entries are missing from metadata
 * - The actual secret values can't be read from the encrypted store
 */
export async function readTelegramCredentials(): Promise<TelegramCredentials | null> {
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

    const botToken = await readCredential(
      credentialKey("telegram", "bot_token"),
    );
    const webhookSecret = await readCredential(
      credentialKey("telegram", "webhook_secret"),
    );

    if (!botToken || !webhookSecret) {
      log.warn(
        "Telegram credential metadata exists but secrets could not be read",
      );
      return null;
    }

    return { botToken, webhookSecret };
  } catch (err) {
    log.debug({ err }, "Failed to read Telegram credentials");
    return null;
  }
}

/**
 * Check the credential metadata file for Twilio credentials and read
 * them from the encrypted store.
 *
 * Returns `null` if:
 * - The metadata file doesn't exist or can't be parsed
 * - Twilio account_sid or auth_token entries are missing from metadata
 * - The actual secret values can't be read from the encrypted store
 */
export async function readTwilioCredentials(): Promise<TwilioCredentials | null> {
  try {
    const metadataPath = getMetadataPath();
    if (!existsSync(metadataPath)) return null;

    const raw = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.credentials)) return null;

    const hasAccountSid = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "twilio" && c.field === "account_sid",
    );
    const hasAuthToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "twilio" && c.field === "auth_token",
    );

    if (!hasAccountSid || !hasAuthToken) return null;

    const accountSid = await readCredential(
      credentialKey("twilio", "account_sid"),
    );
    const authToken = await readCredential(
      credentialKey("twilio", "auth_token"),
    );

    if (!accountSid || !authToken) {
      log.warn(
        "Twilio credential metadata exists but secrets could not be read",
      );
      return null;
    }

    return { accountSid, authToken };
  } catch (err) {
    log.debug({ err }, "Failed to read Twilio credentials");
    return null;
  }
}

export type SlackChannelCredentials = {
  /** Slack Bot User OAuth Token (xoxb-...). */
  botToken: string;
  /** Slack App-Level Token for Socket Mode (xapp-...). */
  appToken: string;
};

/**
 * Check the credential metadata file for Slack channel credentials and read
 * them from the encrypted store.
 *
 * Returns `null` if:
 * - The metadata file doesn't exist or can't be parsed
 * - Slack channel bot_token or app_token entries are missing from metadata
 * - The actual secret values can't be read from the encrypted store
 */
export async function readSlackChannelCredentials(): Promise<SlackChannelCredentials | null> {
  try {
    const metadataPath = getMetadataPath();
    if (!existsSync(metadataPath)) return null;

    const raw = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.credentials)) return null;

    const hasBotToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "slack_channel" && c.field === "bot_token",
    );
    const hasAppToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "slack_channel" && c.field === "app_token",
    );

    if (!hasBotToken || !hasAppToken) return null;

    const botToken = await readCredential(
      credentialKey("slack_channel", "bot_token"),
    );
    const appToken = await readCredential(
      credentialKey("slack_channel", "app_token"),
    );

    if (!botToken || !appToken) {
      log.warn(
        "Slack channel credential metadata exists but secrets could not be read",
      );
      return null;
    }

    return { botToken, appToken };
  } catch (err) {
    log.debug({ err }, "Failed to read Slack channel credentials");
    return null;
  }
}

export type WhatsAppCredentials = {
  /** WhatsApp Business phone number ID (numeric string). */
  phoneNumberId: string;
  /** Long-lived System User access token or temporary access token. */
  accessToken: string;
  /** App secret used to verify X-Hub-Signature-256 on incoming webhooks. */
  appSecret: string;
  /** Webhook verify token used during the Meta webhook subscription handshake. */
  webhookVerifyToken: string;
};

/**
 * Check the credential metadata file for WhatsApp credentials and read
 * them from the encrypted store.
 *
 * Returns `null` if:
 * - The metadata file doesn't exist or can't be parsed
 * - Required WhatsApp entries are missing from metadata
 * - The actual secret values can't be read from the encrypted store
 */
export async function readWhatsAppCredentials(): Promise<WhatsAppCredentials | null> {
  try {
    const metadataPath = getMetadataPath();
    if (!existsSync(metadataPath)) return null;

    const raw = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.credentials)) return null;

    const hasPhoneNumberId = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "whatsapp" && c.field === "phone_number_id",
    );
    const hasAccessToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "whatsapp" && c.field === "access_token",
    );
    const hasAppSecret = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "whatsapp" && c.field === "app_secret",
    );
    const hasWebhookVerifyToken = data.credentials.some(
      (c: { service?: string; field?: string }) =>
        c.service === "whatsapp" && c.field === "webhook_verify_token",
    );

    if (
      !hasPhoneNumberId ||
      !hasAccessToken ||
      !hasAppSecret ||
      !hasWebhookVerifyToken
    )
      return null;

    const phoneNumberId = await readCredential(
      credentialKey("whatsapp", "phone_number_id"),
    );
    const accessToken = await readCredential(
      credentialKey("whatsapp", "access_token"),
    );
    const appSecret = await readCredential(
      credentialKey("whatsapp", "app_secret"),
    );
    const webhookVerifyToken = await readCredential(
      credentialKey("whatsapp", "webhook_verify_token"),
    );

    if (!phoneNumberId || !accessToken || !appSecret || !webhookVerifyToken) {
      log.warn(
        "WhatsApp credential metadata exists but secrets could not be read",
      );
      return null;
    }

    return { phoneNumberId, accessToken, appSecret, webhookVerifyToken };
  } catch (err) {
    log.debug({ err }, "Failed to read WhatsApp credentials");
    return null;
  }
}
