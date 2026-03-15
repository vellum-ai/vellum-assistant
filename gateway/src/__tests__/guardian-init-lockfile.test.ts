import { describe, test, expect, mock, afterEach } from "bun:test";
import * as actualFs from "node:fs";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let lockFileExists = false;
let writtenLockFiles: string[] = [];

mock.module("node:fs", () => ({
  ...actualFs,
  existsSync: (p: string) => {
    if (typeof p === "string" && p.endsWith("guardian-init.lock")) {
      return lockFileExists;
    }
    return actualFs.existsSync(p);
  },
  writeFileSync: (
    p: string,
    data: string | NodeJS.ArrayBufferView,
    options?: actualFs.WriteFileOptions,
  ) => {
    if (typeof p === "string" && p.endsWith("guardian-init.lock")) {
      writtenLockFiles.push(p);
      lockFileExists = true;
      return;
    }
    return actualFs.writeFileSync(p, data, options);
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
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
  lockFileExists = false;
  writtenLockFiles = [];
});

describe("guardian/init one-time-use lockfile", () => {
  test("first call succeeds and creates lock file", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "test-jwt", refreshToken: "test-rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBe("test-jwt");
    expect(writtenLockFiles.length).toBe(1);
    expect(writtenLockFiles[0]).toContain("guardian-init.lock");
  });

  test("second call is rejected with 403", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "test-jwt", refreshToken: "test-rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    // First call succeeds
    const res1 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );
    expect(res1.status).toBe(200);

    // Second call rejected
    const res2 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );
    expect(res2.status).toBe(403);
    const body = await res2.json();
    expect(body.error).toBe("Bootstrap already completed");
  });

  test("concurrent requests are rejected by in-memory guard", async () => {
    let resolveProxy: (() => void) | undefined;
    fetchMock = mock(async () => {
      await new Promise<void>((resolve) => {
        resolveProxy = resolve;
      });
      return new Response(
        JSON.stringify({ accessToken: "test-jwt", refreshToken: "test-rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const makeReq = () =>
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      });

    // Fire two requests concurrently
    const p1 = handler.handleGuardianInit(makeReq());
    const p2 = handler.handleGuardianInit(makeReq());

    // Second request should be rejected immediately by in-memory guard
    const res2 = await p2;
    expect(res2.status).toBe(403);

    // Resolve the first request's proxy call
    resolveProxy!();
    const res1 = await p1;
    expect(res1.status).toBe(200);

    // Lock file should only be written once
    expect(writtenLockFiles.length).toBe(1);
  });

  test("lock file is not created when upstream returns an error", async () => {
    fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(500);
    expect(writtenLockFiles.length).toBe(0);
  });
});
