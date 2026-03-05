import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir, userInfo } from "node:os";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Server } from "node:net";
import { createServer } from "node:net";

// ---------------------------------------------------------------------------
// Mock logger — capture log calls to verify no secrets leak
// ---------------------------------------------------------------------------

const logCalls: { level: string; args: unknown[] }[] = [];

mock.module("../logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        (_target, prop) =>
        (...args: unknown[]) => {
          logCalls.push({ level: String(prop), args });
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
  const encryptedEntries: Record<
    string,
    { iv: string; tag: string; data: string }
  > = {};
  for (const [account, value] of Object.entries(entries)) {
    const iv = randomBytes(12);
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

  const store = {
    version: 1,
    salt: salt.toString("hex"),
    entries: encryptedEntries,
  };
  writeFileSync(storePath, JSON.stringify(store));
}

// ---------------------------------------------------------------------------
// Broker test helpers
// ---------------------------------------------------------------------------

const SOCKET_PATH = join(testDir, "broker.sock");
const TEST_TOKEN = "test-auth-token-abc123";

function writeBrokerToken(token: string): void {
  const tokenDir = join(testDir, ".vellum", "protected");
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "keychain-broker.token"), token);
}

function createMockBroker(): {
  server: Server;
  setHandler: (
    fn: (request: Record<string, unknown>) => Record<string, unknown>,
  ) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let handler: (
    request: Record<string, unknown>,
  ) => Record<string, unknown> = () => ({ ok: true });

  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const request = JSON.parse(line);
          const response = handler(request);
          conn.write(JSON.stringify({ id: request.id, ...response }) + "\n");
        } catch {
          // Malformed request — ignore
        }
      }
    });
  });

  return {
    server,
    setHandler: (fn) => {
      handler = fn;
    },
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(SOCKET_PATH, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedBrokerSocket: string | undefined;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  savedBrokerSocket = process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
  delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
  logCalls.length = 0;
  // Clean up socket file from prior test
  try {
    rmSync(SOCKET_PATH, { force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  delete process.env.BASE_DATA_DIR;
  if (savedBrokerSocket === undefined) {
    delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
  } else {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = savedBrokerSocket;
  }
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
  test("returns null when metadata file does not exist", () => {
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata has no Telegram entries", () => {
    writeMetadata([{ service: "github", field: "token" }]);
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata exists but secrets are missing from encrypted store", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns credentials from encrypted store", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStore({
      "credential:telegram:bot_token": "enc-bot-token",
      "credential:telegram:webhook_secret": "enc-webhook-secret",
    });

    const result = readTelegramCredentials();
    expect(result).toEqual({
      botToken: "enc-bot-token",
      webhookSecret: "enc-webhook-secret",
    });
  });
});

describe("log output: no plaintext secrets", () => {
  test("log messages never contain secret values", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStore({
      "credential:telegram:bot_token": "SUPER_SECRET_TOKEN_123",
      "credential:telegram:webhook_secret": "SUPER_SECRET_WEBHOOK_456",
    });

    const result = readTelegramCredentials();

    // Verify credentials were actually returned
    expect(result).not.toBeNull();
    expect(result!.botToken).toBe("SUPER_SECRET_TOKEN_123");

    // Verify no secret values appear in any log output
    const allLogText = JSON.stringify(logCalls);
    expect(allLogText).not.toContain("SUPER_SECRET_TOKEN_123");
    expect(allLogText).not.toContain("SUPER_SECRET_WEBHOOK_456");
  });
});

// ---------------------------------------------------------------------------
// Tests: broker credential reading
// ---------------------------------------------------------------------------

describe("readCredential broker integration", () => {
  test("returns undefined when broker env var is unset", () => {
    delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;
    const result = readCredential("credential:test:key");
    expect(result).toBeUndefined();
  });

  test("falls back to encrypted store when broker is unavailable", () => {
    // No broker socket configured — should fall through to encrypted store
    delete process.env.VELLUM_KEYCHAIN_BROKER_SOCKET;

    writeEncryptedStore({
      "credential:test:key": "encrypted-value",
    });

    const result = readCredential("credential:test:key");
    expect(result).toBe("encrypted-value");
  });

  test("falls back to encrypted store when broker socket path is set but no server", () => {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = "/tmp/nonexistent-broker.sock";
    writeBrokerToken(TEST_TOKEN);

    writeEncryptedStore({
      "credential:test:key": "encrypted-value",
    });

    const result = readCredential("credential:test:key");
    expect(result).toBe("encrypted-value");
  });

  test("falls back to encrypted store when broker token file is missing", () => {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
    // Don't write a token file

    writeEncryptedStore({
      "credential:test:key": "encrypted-value",
    });

    const result = readCredential("credential:test:key");
    expect(result).toBe("encrypted-value");
  });

  test("reads credential from broker when available", async () => {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
    writeBrokerToken(TEST_TOKEN);

    const broker = createMockBroker();
    broker.setHandler((req) => {
      if (
        req.method === "get" &&
        req.account === "credential:test:key" &&
        req.token === TEST_TOKEN
      ) {
        return { ok: true, value: "broker-secret-value" };
      }
      return { ok: false, error: "not found" };
    });
    await broker.start();

    try {
      const result = readCredential("credential:test:key");
      expect(result).toBe("broker-secret-value");
    } finally {
      await broker.stop();
    }
  });

  test("broker result takes priority over encrypted store", async () => {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
    writeBrokerToken(TEST_TOKEN);

    // Write a value to the encrypted store
    writeEncryptedStore({
      "credential:test:key": "encrypted-value",
    });

    // Also set up broker to return a different value
    const broker = createMockBroker();
    broker.setHandler((req) => {
      if (req.method === "get" && req.account === "credential:test:key") {
        return { ok: true, value: "broker-value" };
      }
      return { ok: false, error: "not found" };
    });
    await broker.start();

    try {
      const result = readCredential("credential:test:key");
      expect(result).toBe("broker-value");
    } finally {
      await broker.stop();
    }
  });

  test("falls back to encrypted store when broker returns not found", async () => {
    process.env.VELLUM_KEYCHAIN_BROKER_SOCKET = SOCKET_PATH;
    writeBrokerToken(TEST_TOKEN);

    writeEncryptedStore({
      "credential:test:key": "encrypted-value",
    });

    const broker = createMockBroker();
    broker.setHandler(() => {
      return { ok: false, error: "not found" };
    });
    await broker.start();

    try {
      const result = readCredential("credential:test:key");
      expect(result).toBe("encrypted-value");
    } finally {
      await broker.stop();
    }
  });
});
