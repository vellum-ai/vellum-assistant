import { describe, test, expect, mock, afterEach } from "bun:test";
import * as actualFs from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { GatewayConfig } from "../config.js";

// Generate a realistic 32-byte signing key for tests.
const TEST_SIGNING_KEY = randomBytes(32);

// Compute the expected key path so we can intercept reads.
const TEST_SECURITY_DIR = "/tmp/test-gateway-security";
const SIGNING_KEY_PATH = join(TEST_SECURITY_DIR, "actor-token-signing-key");

// Track lockfile state.
let lockFileExists = false;
let writtenLockFiles: string[] = [];

mock.module("node:fs", () => ({
  ...actualFs,
  existsSync: (p: string) => {
    if (typeof p === "string" && p.endsWith("signing-key-bootstrap.lock")) {
      return lockFileExists;
    }
    return actualFs.existsSync(p);
  },
  readFileSync: (p: string, ...args: unknown[]) => {
    if (p === SIGNING_KEY_PATH) {
      return Buffer.from(TEST_SIGNING_KEY);
    }
    return (actualFs.readFileSync as Function)(p, ...args);
  },
  writeFileSync: (
    p: string,
    data: string | NodeJS.ArrayBufferView,
    options?: actualFs.WriteFileOptions,
  ) => {
    if (typeof p === "string" && p.endsWith("signing-key-bootstrap.lock")) {
      writtenLockFiles.push(p);
      lockFileExists = true;
      return;
    }
    return actualFs.writeFileSync(p, data, options);
  },
}));

// Set GATEWAY_SECURITY_DIR so getSigningKeyPath() resolves to our test path.
process.env.GATEWAY_SECURITY_DIR = TEST_SECURITY_DIR;

const { createSigningKeyBootstrapHandler } = await import(
  "../http/routes/signing-key-bootstrap.js"
);

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

afterEach(() => {
  lockFileExists = false;
  writtenLockFiles = [];
});

describe("signing-key-bootstrap endpoint", () => {
  test("first call returns 200 with hex-encoded 32-byte key", async () => {
    const handler = createSigningKeyBootstrapHandler(makeConfig());
    const res = await handler.handleGetSigningKey(
      new Request("http://localhost:7830/internal/signing-key-bootstrap"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(typeof body.key).toBe("string");

    // Verify the hex decodes to exactly 32 bytes.
    const decoded = Buffer.from(body.key, "hex");
    expect(decoded.length).toBe(32);

    // Verify it matches the test key.
    expect(decoded.equals(TEST_SIGNING_KEY)).toBe(true);
  });

  test("second call returns 403 'Bootstrap already completed'", async () => {
    const handler = createSigningKeyBootstrapHandler(makeConfig());

    // First call succeeds.
    const res1 = await handler.handleGetSigningKey(
      new Request("http://localhost:7830/internal/signing-key-bootstrap"),
    );
    expect(res1.status).toBe(200);

    // Second call rejected.
    const res2 = await handler.handleGetSigningKey(
      new Request("http://localhost:7830/internal/signing-key-bootstrap"),
    );
    expect(res2.status).toBe(403);
    const body = (await res2.json()) as { error: string };
    expect(body.error).toBe("Bootstrap already completed");
  });

  test("lockfile is written after successful response", async () => {
    const handler = createSigningKeyBootstrapHandler(makeConfig());
    await handler.handleGetSigningKey(
      new Request("http://localhost:7830/internal/signing-key-bootstrap"),
    );

    expect(writtenLockFiles.length).toBe(1);
    expect(writtenLockFiles[0]).toContain("signing-key-bootstrap.lock");
  });

  test("returned hex decodes to exactly 32 bytes", async () => {
    const handler = createSigningKeyBootstrapHandler(makeConfig());
    const res = await handler.handleGetSigningKey(
      new Request("http://localhost:7830/internal/signing-key-bootstrap"),
    );

    const body = (await res.json()) as { key: string };
    const decoded = Buffer.from(body.key, "hex");
    expect(decoded.length).toBe(32);
  });
});
