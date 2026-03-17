import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { hostname, tmpdir, userInfo } from "node:os";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { credentialKey } from "../credential-key.js";

// ---------------------------------------------------------------------------
// Logger mock — captures all log calls so the secret-leak test can inspect them
// ---------------------------------------------------------------------------

const logCalls: { method: string; args: unknown[] }[] = [];

mock.module("../logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => {
          logCalls.push({ method: prop, args });
        };
      },
    }),
}));

import {
  readCredential,
  readTelegramCredentials,
} from "../credential-reader.js";

// ---------------------------------------------------------------------------
// Temp directory for metadata / encrypted store fixtures
// ---------------------------------------------------------------------------

const testDir = join(
  tmpdir(),
  `cred-reader-test-${randomBytes(4).toString("hex")}`,
);

function metadataDir(): string {
  return join(testDir, ".vellum", "workspace", "data", "credentials");
}

function writeMetadata(
  credentials: { service: string; field: string }[],
): void {
  const dir = metadataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ credentials }));
}

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

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
  // Must match assistant/src/util/platform.ts#getPlatformName.
  parts.push(process.platform);
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

function encryptEntries(
  entries: Record<string, string>,
  key: Buffer,
): Record<string, { iv: string; tag: string; data: string }> {
  const encryptedEntries: Record<
    string,
    { iv: string; tag: string; data: string }
  > = {};
  for (const [account, value] of Object.entries(entries)) {
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([
      cipher.update(value, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    encryptedEntries[account] = {
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted.toString("hex"),
    };
  }
  return encryptedEntries;
}

function writeEncryptedStore(entries: Record<string, string>): void {
  const storePath = join(testDir, ".vellum", "protected", "keys.enc");
  mkdirSync(join(testDir, ".vellum", "protected"), { recursive: true });

  const salt = randomBytes(16);
  const key = pbkdf2Sync(
    getMachineEntropy(),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha512",
  );

  const store = {
    version: 1,
    salt: salt.toString("hex"),
    entries: encryptEntries(entries, key),
  };
  writeFileSync(storePath, JSON.stringify(store));
}

/**
 * Write a v2 encrypted store with a random store.key file.
 * The store.key is used directly as the AES-256-GCM key (no PBKDF2).
 */
function writeEncryptedStoreV2(entries: Record<string, string>): void {
  const protectedDir = join(testDir, ".vellum", "protected");
  mkdirSync(protectedDir, { recursive: true });

  const storeKey = randomBytes(KEY_LENGTH);
  writeFileSync(join(protectedDir, "store.key"), storeKey);

  const store = {
    version: 2,
    entries: encryptEntries(entries, storeKey),
  };
  writeFileSync(join(protectedDir, "keys.enc"), JSON.stringify(store));
}

// ---------------------------------------------------------------------------
// Broker test helpers — mock UDS server
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-auth-token-abc123";

function writeBrokerToken(token: string): void {
  const tokenDir = join(testDir, ".vellum", "protected");
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "keychain-broker.token"), token);
}

/**
 * Create a mock keychain broker UDS server that responds to key.get requests.
 * Listens on the derived socket path (getRootDir() + keychain-broker.sock).
 * Returns the socket path and a handle to close the server.
 */
function createMockBroker(credentials: Record<string, string>): {
  socketPath: string;
  server: Server;
  close: () => void;
} {
  const socketPath = join(testDir, ".vellum", "keychain-broker.sock");
  mkdirSync(join(testDir, ".vellum"), { recursive: true });

  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const req = JSON.parse(line);
          if (req.token !== TEST_TOKEN) {
            conn.write(
              JSON.stringify({
                id: req.id,
                ok: false,
                error: { code: "UNAUTHORIZED", message: "bad token" },
              }) + "\n",
            );
            return;
          }
          if (req.method === "key.get") {
            const account = req.params?.account;
            const value = credentials[account];
            conn.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result:
                  value !== undefined
                    ? { found: true, value }
                    : { found: false },
              }) + "\n",
            );
          }
        } catch {
          // ignore malformed requests
        }
      }
    });
  });

  server.listen(socketPath);

  return {
    socketPath,
    server,
    close: () => {
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  logCalls.length = 0;
});

afterEach(() => {
  delete process.env.BASE_DATA_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests: encrypted store (existing)
// ---------------------------------------------------------------------------

describe("readTelegramCredentials", () => {
  test("returns null when metadata file does not exist", async () => {
    const result = await readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata has no Telegram entries", async () => {
    writeMetadata([{ service: "github", field: "token" }]);
    const result = await readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata exists but secrets are missing from encrypted store", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    const result = await readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns credentials from encrypted store", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStore({
      [credentialKey("telegram", "bot_token")]: "enc-bot-token",
      [credentialKey("telegram", "webhook_secret")]: "enc-webhook-secret",
    });

    const result = await readTelegramCredentials();
    expect(result).toEqual({
      botToken: "enc-bot-token",
      webhookSecret: "enc-webhook-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: v2 encrypted store (store.key)
// ---------------------------------------------------------------------------

describe("v2 encrypted store with store.key", () => {
  test("reads credential from v2 store when store.key exists", async () => {
    writeEncryptedStoreV2({
      [credentialKey("test", "key")]: "v2-secret-value",
    });

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBe("v2-secret-value");
  });

  test("returns undefined for v2 store when store.key is missing", async () => {
    // Write a v2 store but without the store.key file
    const protectedDir = join(testDir, ".vellum", "protected");
    mkdirSync(protectedDir, { recursive: true });

    const storeKey = randomBytes(KEY_LENGTH);
    const store = {
      version: 2,
      entries: encryptEntries(
        { [credentialKey("test", "key")]: "v2-secret-value" },
        storeKey,
      ),
    };
    writeFileSync(join(protectedDir, "keys.enc"), JSON.stringify(store));
    // Deliberately do NOT write store.key

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBeUndefined();
  });

  test("returns Telegram credentials from v2 store", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStoreV2({
      [credentialKey("telegram", "bot_token")]: "v2-bot-token",
      [credentialKey("telegram", "webhook_secret")]: "v2-webhook-secret",
    });

    const result = await readTelegramCredentials();
    expect(result).toEqual({
      botToken: "v2-bot-token",
      webhookSecret: "v2-webhook-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: v1 encrypted store backward compatibility
// ---------------------------------------------------------------------------

describe("v1 encrypted store backward compatibility", () => {
  test("v1 store continues to work with entropy-based key derivation", async () => {
    writeEncryptedStore({
      [credentialKey("test", "key")]: "v1-secret-value",
    });

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBe("v1-secret-value");
  });
});

// ---------------------------------------------------------------------------
// Tests: broker credential reading
// ---------------------------------------------------------------------------

describe("readCredential broker integration", () => {
  test("returns undefined when socket file does not exist", async () => {
    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBeUndefined();
  });

  test("falls back to encrypted store when socket file does not exist", async () => {
    writeEncryptedStore({
      [credentialKey("test", "key")]: "encrypted-value",
    });

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBe("encrypted-value");
  });

  test("falls back to encrypted store when broker token file is missing", async () => {
    // Create socket file but no token file
    mkdirSync(join(testDir, ".vellum"), { recursive: true });
    writeFileSync(join(testDir, ".vellum", "keychain-broker.sock"), "");

    writeEncryptedStore({
      [credentialKey("test", "key")]: "encrypted-value",
    });

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBe("encrypted-value");
  });

  test("reads credential from broker when available", async () => {
    const broker = createMockBroker({
      [credentialKey("test", "key")]: "broker-secret-value",
    });
    try {
      writeBrokerToken(TEST_TOKEN);

      const result = await readCredential(credentialKey("test", "key"));
      expect(result).toBe("broker-secret-value");
    } finally {
      broker.close();
    }
  });

  test("broker result takes priority over encrypted store", async () => {
    const broker = createMockBroker({
      [credentialKey("test", "key")]: "broker-value",
    });
    try {
      writeBrokerToken(TEST_TOKEN);

      writeEncryptedStore({
        [credentialKey("test", "key")]: "encrypted-value",
      });

      const result = await readCredential(credentialKey("test", "key"));
      expect(result).toBe("broker-value");
    } finally {
      broker.close();
    }
  });

  test("falls back to encrypted store when broker returns not found", async () => {
    // Broker has no entry for the test credential key
    const broker = createMockBroker({});
    try {
      writeBrokerToken(TEST_TOKEN);

      writeEncryptedStore({
        [credentialKey("test", "key")]: "encrypted-value",
      });

      const result = await readCredential(credentialKey("test", "key"));
      expect(result).toBe("encrypted-value");
    } finally {
      broker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: secret values must not leak into log output
// ---------------------------------------------------------------------------

describe("secret leak prevention", () => {
  function allLogStrings(): string {
    return JSON.stringify(logCalls);
  }

  test("broker read does not leak secret values into logs", async () => {
    const secretValue = "super-secret-broker-credential-value";
    const broker = createMockBroker({
      [credentialKey("leak-test", "key")]: secretValue,
    });
    try {
      writeBrokerToken(TEST_TOKEN);

      const result = await readCredential(credentialKey("leak-test", "key"));
      expect(result).toBe(secretValue);

      const serialized = allLogStrings();
      expect(serialized).not.toContain(secretValue);
      // The auth token used for broker handshake should also stay out of logs
      expect(serialized).not.toContain(TEST_TOKEN);
    } finally {
      broker.close();
    }
  });

  test("encrypted store read does not leak secret values into logs", async () => {
    const secretValue = "super-secret-encrypted-credential-value";

    writeEncryptedStore({
      [credentialKey("leak-test", "key")]: secretValue,
    });

    const result = await readCredential(credentialKey("leak-test", "key"));
    expect(result).toBe(secretValue);

    const serialized = allLogStrings();
    expect(serialized).not.toContain(secretValue);
  });

  test("failed encrypted store read does not leak secret values into logs", async () => {
    const secretValue = "super-secret-telegram-token";

    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);
    writeEncryptedStore({
      [credentialKey("telegram", "bot_token")]: secretValue,
      [credentialKey("telegram", "webhook_secret")]: "webhook-secret-value",
    });

    const result = await readTelegramCredentials();
    expect(result).not.toBeNull();

    const serialized = allLogStrings();
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("webhook-secret-value");
  });
});
