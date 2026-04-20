import { describe, test, expect, mock, afterEach } from "bun:test";
import * as actualFs from "node:fs";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

let lockFileExists = false;
let consumedSecretsContent: string | null = null;
const unlinked: string[] = [];

mock.module("node:fs", () => ({
  ...actualFs,
  existsSync: (p: string) => {
    if (typeof p === "string" && p.endsWith("guardian-init.lock")) {
      return lockFileExists;
    }
    if (typeof p === "string" && p.endsWith("guardian-init-consumed.json")) {
      return consumedSecretsContent !== null;
    }
    return actualFs.existsSync(p);
  },
  unlinkSync: (p: string) => {
    if (typeof p === "string" && p.endsWith("guardian-init.lock")) {
      unlinked.push(p);
      lockFileExists = false;
      return;
    }
    if (typeof p === "string" && p.endsWith("guardian-init-consumed.json")) {
      unlinked.push(p);
      consumedSecretsContent = null;
      return;
    }
    return actualFs.unlinkSync(p);
  },
}));

const { createChannelVerificationSessionProxyHandler } =
  await import("../http/routes/channel-verification-session-proxy.js");

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

function makeReq(): Request {
  return new Request("http://localhost:7830/v1/guardian/reset-bootstrap", {
    method: "POST",
  });
}

afterEach(() => {
  lockFileExists = false;
  consumedSecretsContent = null;
  unlinked.length = 0;
  delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
});

describe("guardian/reset-bootstrap", () => {
  test("deletes lock and consumed files on loopback request in bare-metal mode", async () => {
    lockFileExists = true;
    consumedSecretsContent = "[0]";

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(
      makeReq(),
      "127.0.0.1",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });
    expect(lockFileExists).toBe(false);
    expect(consumedSecretsContent).toBeNull();
    expect(unlinked.length).toBe(2);
  });

  test("succeeds when lock does not exist (idempotent)", async () => {
    lockFileExists = false;
    consumedSecretsContent = null;

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(
      makeReq(),
      "127.0.0.1",
    );

    expect(res.status).toBe(200);
    expect(unlinked.length).toBe(0);
  });

  test("accepts IPv6 loopback", async () => {
    lockFileExists = true;

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(makeReq(), "::1");

    expect(res.status).toBe(200);
    expect(lockFileExists).toBe(false);
  });

  test("rejects non-loopback clients with 403", async () => {
    lockFileExists = true;

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(
      makeReq(),
      "192.168.1.50",
    );

    expect(res.status).toBe(403);
    expect(lockFileExists).toBe(true);
  });

  test("rejects requests with no client IP with 403", async () => {
    lockFileExists = true;

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(
      makeReq(),
      undefined,
    );

    expect(res.status).toBe(403);
    expect(lockFileExists).toBe(true);
  });

  test("rejects requests when GUARDIAN_BOOTSTRAP_SECRET is set (Docker mode)", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "secret";
    lockFileExists = true;

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianResetBootstrap(
      makeReq(),
      "127.0.0.1",
    );

    expect(res.status).toBe(403);
    expect(lockFileExists).toBe(true);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });
});
