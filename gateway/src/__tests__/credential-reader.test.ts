import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir, userInfo } from "node:os";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

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

import { readTelegramCredentials } from "../credential-reader.js";

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
// Tests
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
