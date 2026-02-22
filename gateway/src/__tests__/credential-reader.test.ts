import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock logger — capture log calls to verify no secrets leak
// ---------------------------------------------------------------------------

const logCalls: { level: string; args: unknown[] }[] = [];

mock.module("../logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) =>
        (...args: unknown[]) => {
          logCalls.push({ level: String(prop), args });
        },
    }),
}));

// ---------------------------------------------------------------------------
// Mock execFileSync — intercept keychain CLI calls
// ---------------------------------------------------------------------------

let execFileSyncMock: ReturnType<typeof mock>;

mock.module("node:child_process", () => {
  execFileSyncMock = mock(() => {
    throw new Error("not found");
  });
  return { execFileSync: execFileSyncMock };
});

import {
  readTelegramCredentials,
  readCredential,
  readKeychainCredential,
  getMetadataPath,
  getRootDir,
} from "../credential-reader.js";

// ---------------------------------------------------------------------------
// Temp directory for metadata / encrypted store fixtures
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `cred-reader-test-${randomBytes(4).toString("hex")}`);

function metadataDir(): string {
  return join(testDir, ".vellum", "workspace", "data", "credentials");
}

function writeMetadata(credentials: { service: string; field: string }[]): void {
  const dir = metadataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ credentials }));
}

const originalPlatform = process.platform;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  logCalls.length = 0;
  execFileSyncMock.mockReset();
  // Default: execFileSync throws (credential not found in keychain)
  execFileSyncMock.mockImplementation(() => {
    throw new Error("not found");
  });
});

afterEach(() => {
  delete process.env.BASE_DATA_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  // Restore platform in case a test changed it
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readTelegramCredentials: encrypted store only (existing behavior)", () => {
  test("returns null when metadata file does not exist", () => {
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata has no Telegram entries", () => {
    writeMetadata([{ service: "github", field: "token" }]);
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });

  test("returns null when metadata exists but secrets are missing from both backends", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // Keychain returns nothing (throws), encrypted store has no file
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });
});

describe("readTelegramCredentials: keychain on macOS", () => {
  test("returns credentials from keychain when available on macOS", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // Simulate keychain returning credentials
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const aIdx = (args as string[]).indexOf("-a");
      const account = (args as string[])[aIdx + 1];
      if (account === "credential:telegram:bot_token") return "kc-bot-token\n";
      if (account === "credential:telegram:webhook_secret") return "kc-webhook-secret\n";
      throw new Error("not found");
    });

    const result = readTelegramCredentials();
    expect(result).toEqual({
      botToken: "kc-bot-token",
      webhookSecret: "kc-webhook-secret",
    });
  });

  test("prefers keychain over encrypted store on macOS", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // Keychain returns credentials — encrypted store should not be consulted
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const aIdx = (args as string[]).indexOf("-a");
      const account = (args as string[])[aIdx + 1];
      if (account === "credential:telegram:bot_token") return "keychain-token\n";
      if (account === "credential:telegram:webhook_secret") return "keychain-secret\n";
      throw new Error("not found");
    });

    const result = readTelegramCredentials();
    expect(result).not.toBeNull();
    expect(result!.botToken).toBe("keychain-token");
    expect(result!.webhookSecret).toBe("keychain-secret");
  });

  test("falls back to encrypted store when keychain has no credentials", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // Keychain throws (credential not found) — fall through to encrypted store
    // Encrypted store also has nothing, so result should be null
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });
});

describe("readTelegramCredentials: non-macOS platforms", () => {
  test("skips keychain on non-macOS and uses encrypted store", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // readKeychainCredential should return undefined on linux
    const keychainResult = readKeychainCredential("credential:telegram:bot_token");
    expect(keychainResult).toBeUndefined();

    // execFileSync should NOT have been called since platform is not darwin
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("readTelegramCredentials: neither backend has credentials", () => {
  test("returns null when both keychain and encrypted store have nothing", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    // Keychain throws, encrypted store file doesn't exist
    const result = readTelegramCredentials();
    expect(result).toBeNull();
  });
});

describe("readKeychainCredential", () => {
  test("returns credential value from keychain on macOS", () => {
    execFileSyncMock.mockImplementation(() => "my-secret-value\n");

    const result = readKeychainCredential("credential:telegram:bot_token");
    expect(result).toBe("my-secret-value");
  });

  test("returns undefined when keychain throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found");
    });

    const result = readKeychainCredential("credential:telegram:bot_token");
    expect(result).toBeUndefined();
  });

  test("returns undefined on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    const result = readKeychainCredential("credential:telegram:bot_token");
    expect(result).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  test("passes correct service name and account to security CLI", () => {
    execFileSyncMock.mockImplementation(() => "value\n");

    readKeychainCredential("credential:telegram:bot_token");

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "vellum-assistant", "-a", "credential:telegram:bot_token", "-w"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
  });
});

describe("log output: no plaintext secrets", () => {
  test("log messages never contain secret values", () => {
    writeMetadata([
      { service: "telegram", field: "bot_token" },
      { service: "telegram", field: "webhook_secret" },
    ]);

    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const aIdx = (args as string[]).indexOf("-a");
      const account = (args as string[])[aIdx + 1];
      if (account === "credential:telegram:bot_token") return "SUPER_SECRET_TOKEN_123\n";
      if (account === "credential:telegram:webhook_secret") return "SUPER_SECRET_WEBHOOK_456\n";
      throw new Error("not found");
    });

    const result = readTelegramCredentials();

    // Verify credentials were actually returned (mock is working)
    expect(result).not.toBeNull();
    expect(result!.botToken).toBe("SUPER_SECRET_TOKEN_123");

    // Verify no secret values appear in any log output
    const allLogText = JSON.stringify(logCalls);
    expect(allLogText).not.toContain("SUPER_SECRET_TOKEN_123");
    expect(allLogText).not.toContain("SUPER_SECRET_WEBHOOK_456");
  });
});
