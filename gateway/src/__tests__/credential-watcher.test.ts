/**
 * End-to-end integration test: starts the REAL gateway process, queries
 * /webhooks/telegram before and after writing credentials to disk, and
 * asserts the gateway hot-reloads them.
 *
 * Reproduces the fresh-hatch bug where the credentials directory doesn't
 * exist when the gateway boots, causing fs.watch() to silently fail.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes as cryptoRandomBytes,
} from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants — must match credential-reader.ts
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

// ---------------------------------------------------------------------------
// Temp directory — credentials directory intentionally does NOT exist
// ---------------------------------------------------------------------------

const testDir = join(
  tmpdir(),
  `gw-e2e-${cryptoRandomBytes(4).toString("hex")}`,
);

// ---------------------------------------------------------------------------
// Encrypted credential store helpers (mirrors credential-reader.ts)
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
  // Must mirror assistant/src/util/platform.ts#getPlatformName (raw platform).
  parts.push(process.platform);
  parts.push(process.arch);
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

function encrypt(
  value: string,
  key: Buffer,
): { iv: string; tag: string; data: string } {
  const iv = cryptoRandomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(value, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

/**
 * Write Telegram bot_token and webhook_secret into the encrypted store
 * at $BASE_DATA_DIR/.vellum/protected/keys.enc, using the same key
 * derivation the gateway's credential-reader will use to decrypt.
 */
function writeEncryptedStore(botToken: string, webhookSecret: string): void {
  const storePath = join(testDir, ".vellum", "protected", "keys.enc");
  mkdirSync(dirname(storePath), { recursive: true });

  const salt = cryptoRandomBytes(16);
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
    entries: {
      "credential/telegram/bot_token": encrypt(botToken, key),
      "credential/telegram/webhook_secret": encrypt(webhookSecret, key),
    },
  };

  writeFileSync(storePath, JSON.stringify(store));
}

/**
 * Write credential metadata so readTelegramCredentials() knows to look
 * for bot_token and webhook_secret.
 */
function writeCredentialMetadata(): void {
  const dir = join(testDir, ".vellum", "workspace", "data", "credentials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify({
      version: 2,
      credentials: [
        {
          credentialId: "test-bt",
          service: "telegram",
          field: "bot_token",
          allowedTools: [],
          allowedDomains: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          credentialId: "test-ws",
          service: "telegram",
          field: "webhook_secret",
          allowedTools: [],
          allowedDomains: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Gateway process helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = join(__dirname, "..", "..");
const gatewayEntry = join(gatewayRoot, "src", "index.ts");

const port = 49152 + Math.floor(Math.random() * 16383);

let gatewayProc: ChildProcess | null = null;

async function startGateway(): Promise<void> {
  gatewayProc = spawn("bun", ["run", gatewayEntry], {
    env: {
      ...process.env,
      BASE_DATA_DIR: testDir,
      GATEWAY_PORT: String(port),
      // Ensure Telegram is NOT configured via env vars
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for /healthz to respond (up to 5s)
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Gateway failed to start within 5 seconds");
}

afterEach(() => {
  if (gatewayProc) {
    gatewayProc.kill();
    gatewayProc = null;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("gateway telegram hot-reload (e2e)", () => {
  test("gateway picks up telegram credentials written after startup when credentials dir was initially missing", async () => {
    // --- Setup: no credentials directory exists (fresh hatch) ---
    mkdirSync(testDir, { recursive: true });

    // Start the real gateway process
    await startGateway();

    const base = `http://localhost:${port}`;

    // --- Step 1: confirm Telegram is NOT configured ---
    const before = await fetch(`${base}/webhooks/telegram`, {
      method: "POST",
    });
    expect(before.status).toBe(503);
    const beforeBody = (await before.json()) as { error: string };
    expect(beforeBody.error).toBe("Telegram integration not configured");

    // --- Step 2: simulate daemon writing credentials ---
    writeEncryptedStore("fake-bot-token:ABC123", "fake-webhook-secret");
    writeCredentialMetadata();

    // Wait for credential watcher debounce (500ms) + generous margin
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // --- Step 3: query again — gateway should now recognize Telegram is configured.
    // We expect 401 (webhook secret verification failed) rather than 503
    // (not configured). Getting past the 503 gate proves the gateway
    // hot-reloaded the credentials from the credential store.
    const after = await fetch(`${base}/webhooks/telegram`, {
      method: "POST",
    });
    expect(after.status).toBe(401);
  }, 15_000);
});
