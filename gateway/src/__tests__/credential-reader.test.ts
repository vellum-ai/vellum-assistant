import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  readServiceCredentials,
  type ServiceCredentialSpec,
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

function protectedDir(): string {
  return join(testDir, ".vellum", "protected");
}

function writeEncryptedStore(entries: Record<string, string>): void {
  const dir = protectedDir();
  mkdirSync(dir, { recursive: true });
  const storePath = join(dir, "keys.enc");

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
  const dir = protectedDir();
  mkdirSync(dir, { recursive: true });

  const storeKey = randomBytes(KEY_LENGTH);
  writeFileSync(join(dir, "store.key"), storeKey);

  const store = {
    version: 2,
    entries: encryptEntries(entries, storeKey),
  };
  writeFileSync(join(dir, "keys.enc"), JSON.stringify(store));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  process.env.GATEWAY_SECURITY_DIR = protectedDir();
  logCalls.length = 0;
});

afterEach(() => {
  delete process.env.BASE_DATA_DIR;
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
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
    const dir = protectedDir();
    mkdirSync(dir, { recursive: true });

    const storeKey = randomBytes(KEY_LENGTH);
    const store = {
      version: 2,
      entries: encryptEntries(
        { [credentialKey("test", "key")]: "v2-secret-value" },
        storeKey,
      ),
    };
    writeFileSync(join(dir, "keys.enc"), JSON.stringify(store));
    // Deliberately do NOT write store.key

    const result = await readCredential(credentialKey("test", "key"));
    expect(result).toBeUndefined();
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
// Tests: generic readServiceCredentials
// ---------------------------------------------------------------------------

describe("readServiceCredentials", () => {
  const telegramSpec: ServiceCredentialSpec = {
    service: "telegram",
    requiredFields: ["bot_token", "webhook_secret"],
  };

  test("returns correct Record<string, string> for a valid spec", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStore({
      [credentialKey("telegram", "bot_token")]: "my-bot-token",
      [credentialKey("telegram", "webhook_secret")]: "my-webhook-secret",
    });

    const result = await readServiceCredentials(telegramSpec);
    expect(result).toEqual({
      bot_token: "my-bot-token",
      webhook_secret: "my-webhook-secret",
    });
  });

  test("returns null when metadata is missing", async () => {
    // No metadata file written at all
    const result = await readServiceCredentials(telegramSpec);
    expect(result).toBeNull();
  });

  test("returns null when metadata has no entries for the service", async () => {
    writeMetadata([{ service: "github", field: "token" }]);

    const result = await readServiceCredentials(telegramSpec);
    expect(result).toBeNull();
  });

  test("returns null when metadata exists but encrypted values cannot be read", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);
    // No encrypted store written — secrets are unreadable

    const result = await readServiceCredentials(telegramSpec);
    expect(result).toBeNull();
  });

  test("returns null when only some required fields exist in metadata", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      // webhook_secret is missing from metadata
    ]);

    writeEncryptedStore({
      [credentialKey("telegram", "bot_token")]: "my-bot-token",
      [credentialKey("telegram", "webhook_secret")]: "my-webhook-secret",
    });

    const result = await readServiceCredentials(telegramSpec);
    expect(result).toBeNull();
  });

  test("works for a hypothetical new service spec (extensibility)", async () => {
    const customSpec: ServiceCredentialSpec = {
      service: "test_service",
      requiredFields: ["api_key", "secret"],
    };

    writeMetadata([
      { service: "test_service", field: "api_key" },
      { service: "test_service", field: "secret" },
    ]);

    writeEncryptedStore({
      [credentialKey("test_service", "api_key")]: "custom-api-key",
      [credentialKey("test_service", "secret")]: "custom-secret",
    });

    const result = await readServiceCredentials(customSpec);
    expect(result).toEqual({
      api_key: "custom-api-key",
      secret: "custom-secret",
    });
  });

  test("works with v2 encrypted store", async () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    writeEncryptedStoreV2({
      [credentialKey("telegram", "bot_token")]: "v2-bot-token",
      [credentialKey("telegram", "webhook_secret")]: "v2-webhook-secret",
    });

    const result = await readServiceCredentials(telegramSpec);
    expect(result).toEqual({
      bot_token: "v2-bot-token",
      webhook_secret: "v2-webhook-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: secret values must not leak into log output
// ---------------------------------------------------------------------------

describe("secret leak prevention", () => {
  function allLogStrings(): string {
    return JSON.stringify(logCalls);
  }

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

  test("service credential read does not leak secret values into logs", async () => {
    const secretValue = "super-secret-telegram-token";

    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);
    writeEncryptedStore({
      [credentialKey("telegram", "bot_token")]: secretValue,
      [credentialKey("telegram", "webhook_secret")]: "webhook-secret-value",
    });

    const result = await readServiceCredentials({
      service: "telegram",
      requiredFields: ["bot_token", "webhook_secret"],
    });
    expect(result).not.toBeNull();

    const serialized = allLogStrings();
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("webhook-secret-value");
  });
});
