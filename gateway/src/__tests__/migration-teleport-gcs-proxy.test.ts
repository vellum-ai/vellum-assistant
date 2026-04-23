import { describe, test, expect, mock, afterEach } from "bun:test";
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

const {
  createMigrationExportToGcsProxyHandler,
  createMigrationImportFromGcsProxyHandler,
  createMigrationJobStatusProxyHandler,
} = await import("../http/routes/migration-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
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
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("teleport-gcs migration proxies", () => {
  test("export-to-gcs: forwards POST body to daemon and returns 202", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedBody: ArrayBuffer | undefined;
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method;
        capturedBody = init?.body as ArrayBuffer;
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response(
          JSON.stringify({ job_id: "job-export-1", status: "pending" }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );

    const handler = createMigrationExportToGcsProxyHandler(makeConfig());
    const bodyText = JSON.stringify({
      upload_url: "https://storage.example/u",
      description: "x",
    });
    const res = await handler(
      new Request("http://localhost:7830/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": "application/json",
        },
        body: bodyText,
      }),
    );

    expect(res.status).toBe(202);
    expect(capturedUrl).toBe(
      "http://localhost:7821/v1/migrations/export-to-gcs",
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
    expect(capturedHeaders?.has("host")).toBe(false);
    expect(Buffer.from(capturedBody!).toString("utf8")).toBe(bodyText);
    expect(await res.json()).toEqual({
      job_id: "job-export-1",
      status: "pending",
    });
  });

  test("import-from-gcs: forwards POST body to daemon and returns 202", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method;
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response(
          JSON.stringify({ job_id: "job-import-1", status: "pending" }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );

    const handler = createMigrationImportFromGcsProxyHandler(makeConfig());
    const res = await handler(
      new Request("http://localhost:7830/v1/migrations/import-from-gcs", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ bundle_url: "https://storage.example/b" }),
      }),
    );

    expect(res.status).toBe(202);
    expect(capturedUrl).toBe(
      "http://localhost:7821/v1/migrations/import-from-gcs",
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
  });

  test("jobs/:job_id: forwards GET to daemon with encoded job id", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method;
        return new Response(
          JSON.stringify({
            job_id: "abc/def",
            type: "export",
            status: "processing",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );

    const handler = createMigrationJobStatusProxyHandler(makeConfig());
    const res = await handler(
      new Request("http://localhost:7830/v1/migrations/jobs/abc%2Fdef"),
      "abc/def",
    );

    expect(res.status).toBe(200);
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toBe(
      "http://localhost:7821/v1/migrations/jobs/abc%2Fdef",
    );
  });

  test("export-to-gcs: returns 502 on upstream connection failure", async () => {
    fetchMock = mock(async () => {
      throw new Error("connection refused");
    });

    const handler = createMigrationExportToGcsProxyHandler(makeConfig());
    const res = await handler(
      new Request("http://localhost:7830/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway" });
  });

  test("jobs/:job_id: forwards upstream non-2xx (e.g. 404 job_not_found)", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: { code: "job_not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createMigrationJobStatusProxyHandler(makeConfig());
    const res = await handler(
      new Request("http://localhost:7830/v1/migrations/jobs/unknown"),
      "unknown",
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "job_not_found" } });
  });
});
