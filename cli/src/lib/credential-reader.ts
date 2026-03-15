/**
 * Read-only reader for the assistant's credential stores.
 *
 * Tries the keychain broker (UDS) first, then falls back to the
 * encrypted-at-rest file (<instanceDir>/.vellum/protected/keys.enc).
 * Mirrors the gateway's credential-reader.ts so both code paths resolve
 * credentials identically regardless of backend (keychain vs file store).
 */

import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const BROKER_TIMEOUT_MS = 5_000;

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
// Machine entropy & encrypted store helpers
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

function readEncryptedCredential(
  vellumDir: string,
  account: string,
): string | undefined {
  try {
    const storePath = join(vellumDir, "protected", "keys.enc");
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

// ---------------------------------------------------------------------------
// Keychain broker reader (UDS)
// ---------------------------------------------------------------------------

async function readBrokerCredential(
  vellumDir: string,
  account: string,
): Promise<string | undefined> {
  const socketPath = join(vellumDir, "keychain-broker.sock");
  if (!existsSync(socketPath)) return undefined;

  const tokenPath = join(vellumDir, "protected", "keychain-broker.token");
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

      let socket: ReturnType<typeof createConnection> | undefined;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket?.destroy();
          } catch {
            /* already destroyed or never created */
          }
          resolve(undefined);
        }
      }, BROKER_TIMEOUT_MS);

      try {
        socket = createConnection({ path: socketPath });
      } catch {
        clearTimeout(timer);
        settled = true;
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

      socket.on("error", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      });
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API — tries broker, then encrypted store
// ---------------------------------------------------------------------------

/**
 * Read a credential from the assistant's secure storage.
 *
 * Tries the keychain broker (UDS) first — used in production on macOS where
 * the daemon writes credentials to the system keychain. Falls back to the
 * encrypted-at-rest file store (keys.enc) for dev mode and environments
 * without a keychain broker.
 *
 * @param instanceDir - The assistant instance directory (e.g. ~/.vellum or a per-instance dir)
 * @param account - The credential key (e.g. "credential/bootstrapped_actor/http_token")
 * @returns The decrypted credential value, or undefined if not found.
 */
export async function readCredential(
  instanceDir: string,
  account: string,
): Promise<string | undefined> {
  const vellumDir = join(instanceDir, ".vellum");
  const brokerValue = await readBrokerCredential(vellumDir, account);
  if (brokerValue !== undefined) return brokerValue;
  return readEncryptedCredential(vellumDir, account);
}
