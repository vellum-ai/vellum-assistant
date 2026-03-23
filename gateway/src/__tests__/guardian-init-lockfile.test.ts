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
let consumedSecretsContent: string | null = null;
let writtenConsumedFiles: string[] = [];

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
  readFileSync: (p: string, encoding?: BufferEncoding) => {
    if (typeof p === "string" && p.endsWith("guardian-init-consumed.json")) {
      if (consumedSecretsContent === null) {
        throw new Error("ENOENT");
      }
      return consumedSecretsContent;
    }
    return actualFs.readFileSync(p, encoding as BufferEncoding);
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
    if (typeof p === "string" && p.endsWith("guardian-init-consumed.json")) {
      consumedSecretsContent = String(data);
      writtenConsumedFiles.push(p);
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
  fetchMock = mock(async () => new Response());
  lockFileExists = false;
  writtenLockFiles = [];
  consumedSecretsContent = null;
  writtenConsumedFiles = [];
});

describe("guardian/init bootstrap secret", () => {
  test("rejects requests without secret when GUARDIAN_BOOTSTRAP_SECRET is set", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(
        new Request("http://localhost:7830/v1/guardian/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Invalid bootstrap secret");
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("rejects requests with wrong secret", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(
        new Request("http://localhost:7830/v1/guardian/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-bootstrap-secret": "wrong-secret",
          },
          body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Invalid bootstrap secret");
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("accepts requests with correct secret and writes lock for single secret", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "test-jwt", refreshToken: "test-rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(
        new Request("http://localhost:7830/v1/guardian/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-bootstrap-secret": "test-secret-abc123",
          },
          body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
        }),
      );

      expect(res.status).toBe(200);
      // Single secret: consumed file written and lock file created immediately
      expect(writtenConsumedFiles.length).toBe(1);
      expect(writtenLockFiles.length).toBe(1);
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("skips secret check when GUARDIAN_BOOTSTRAP_SECRET is not set", async () => {
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
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
  });
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

describe("guardian/init multi-secret consumption tracking", () => {
  const SECRET_A = "secret-laptop-aaa";
  const SECRET_B = "secret-remote-bbb";

  function makeInitRequest(secret?: string): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers["x-bootstrap-secret"] = secret;
    }
    return new Request("http://localhost:7830/v1/guardian/init", {
      method: "POST",
      headers,
      body: JSON.stringify({
        platform: "cli",
        deviceId: `device-${secret ?? "none"}`,
      }),
    });
  }

  test("first secret is consumed but lock is deferred until all secrets used", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "jwt-a", refreshToken: "rt-a" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(makeInitRequest(SECRET_A));

      expect(res.status).toBe(200);
      // Consumed file written, but lock file NOT yet created
      expect(writtenConsumedFiles.length).toBe(1);
      expect(writtenLockFiles.length).toBe(0);
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("lock file written after all secrets consumed", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "jwt", refreshToken: "rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());

      // First secret
      const res1 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
      expect(res1.status).toBe(200);
      expect(writtenLockFiles.length).toBe(0);

      // Second secret
      const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_B));
      expect(res2.status).toBe(200);
      expect(writtenLockFiles.length).toBe(1);
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("reusing a consumed secret is rejected", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "jwt", refreshToken: "rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());

      // Consume SECRET_A
      const res1 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
      expect(res1.status).toBe(200);

      // Try to reuse SECRET_A
      const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
      expect(res2.status).toBe(403);
      const body = await res2.json();
      expect(body.error).toBe("Bootstrap secret already used");
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("all secrets rejected after full consumption and lock", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ accessToken: "jwt", refreshToken: "rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());

      // Consume both
      await handler.handleGuardianInit(makeInitRequest(SECRET_A));
      await handler.handleGuardianInit(makeInitRequest(SECRET_B));
      expect(writtenLockFiles.length).toBe(1);

      // Any further attempt is rejected (lock file exists)
      const res = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("already");
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("concurrent requests with same secret rejected by in-flight guard", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    let resolveProxy: (() => void) | undefined;
    fetchMock = mock(async () => {
      await new Promise<void>((resolve) => {
        resolveProxy = resolve;
      });
      return new Response(
        JSON.stringify({ accessToken: "jwt", refreshToken: "rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());

      // GIVEN a first request with SECRET_A is in flight
      const p1 = handler.handleGuardianInit(makeInitRequest(SECRET_A));

      // WHEN a second request with the same SECRET_A arrives concurrently
      const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));

      // THEN the second request is rejected
      expect(res2.status).toBe(403);
      const body = await res2.json();
      expect(body.error).toBe("Bootstrap secret already used");

      // AND the first request completes successfully once resolved
      resolveProxy!();
      const res1 = await p1;
      expect(res1.status).toBe(200);
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });

  test("consumed secret not recorded when upstream fails", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const handler =
        createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(makeInitRequest(SECRET_A));

      expect(res.status).toBe(500);
      expect(writtenConsumedFiles.length).toBe(0);
      expect(writtenLockFiles.length).toBe(0);
    } finally {
      delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    }
  });
});
