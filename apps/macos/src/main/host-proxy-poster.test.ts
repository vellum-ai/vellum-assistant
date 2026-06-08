import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Stub device-id so we get a deterministic client ID without touching disk.
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), `host-proxy-poster-test-${process.pid}`);
const DEVICE_FILE = path.join(TEST_DIR, "device.json");
const FAKE_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";

let mockEnvironment = "dev";
mock.module("@vellumai/local-mode", () => ({
  resolveConfigDir: () => TEST_DIR,
  resolveEnvironmentName: () => mockEnvironment,
}));

// Write a device.json so getDeviceId returns our deterministic value.
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(
  DEVICE_FILE,
  JSON.stringify({ deviceId: FAKE_DEVICE_ID }, null, 2) + "\n",
);

// Import device-id first so the cache is seeded, then import the poster.
const { resetDeviceIdCache } = await import("./device-id");
resetDeviceIdCache();
const { getDeviceId } = await import("./device-id");
// Prime the cache with our fake ID
getDeviceId();

const { HostProxyPoster } = await import("./host-proxy-poster");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  rawBody: Buffer | null;
}

function createMockFetch(
  status = 200,
  responseBody: unknown = { accepted: true },
) {
  const captured: CapturedRequest[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k] = v;
      }
    }

    let body: string | null = null;
    let rawBody: Buffer | null = null;
    if (init?.body != null) {
      if (typeof init.body === "string") {
        body = init.body;
      } else if (Buffer.isBuffer(init.body)) {
        rawBody = init.body;
      } else if (init.body instanceof Uint8Array) {
        rawBody = Buffer.from(init.body);
      }
    }

    captured.push({ url, method, headers, body, rawBody });

    const resBody =
      typeof responseBody === "string"
        ? responseBody
        : JSON.stringify(responseBody);
    return new Response(resBody, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn: fetchFn as typeof globalThis.fetch, captured };
}

function createBinaryMockFetch(status: number, data: Buffer) {
  const captured: CapturedRequest[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k] = v;
      }
    }
    captured.push({ url, method, headers, body: null, rawBody: null });
    return new Response(data, {
      status,
      headers: { "Content-Type": "application/octet-stream" },
    });
  };
  return { fetchFn: fetchFn as typeof globalThis.fetch, captured };
}

function makePoster(
  fetchFn: typeof globalThis.fetch,
  overrides?: { gatewayPort?: number; gatewayHost?: string; authToken?: string },
) {
  return new HostProxyPoster({
    gatewayPort: overrides?.gatewayPort ?? 9000,
    gatewayHost: overrides?.gatewayHost,
    authToken: overrides?.authToken ?? "test-token",
    fetch: fetchFn,
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  resetDeviceIdCache();
  // Re-prime the cache for the next test
  getDeviceId();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HostProxyPoster", () => {
  describe("postBashResult", () => {
    test("sends correct URL, method, headers, and body", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postBashResult({
        requestId: "req-1",
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });

      expect(result).toBe(true);
      expect(captured).toHaveLength(1);

      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/host-bash-result");
      expect(req.method).toBe("POST");
      expect(req.headers["Content-Type"]).toBe("application/json");
      expect(req.headers["Authorization"]).toBe("Bearer test-token");
      expect(req.headers["X-Vellum-Client-Id"]).toBe(FAKE_DEVICE_ID);

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-1");
      expect(body.stdout).toBe("hello");
      expect(body.exitCode).toBe(0);
    });
  });

  describe("postFileResult", () => {
    test("sends correct URL and body fields", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postFileResult({
        requestId: "req-2",
        content: "file-content",
        isError: false,
        imageData: "base64img",
      });

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/host-file-result");

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-2");
      expect(body.content).toBe("file-content");
      expect(body.imageData).toBe("base64img");
    });
  });

  describe("postTransferResult", () => {
    test("sends correct URL and body fields", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postTransferResult({
        requestId: "req-3",
        isError: false,
        bytesWritten: 1024,
      });

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/host-transfer-result");

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-3");
      expect(body.bytesWritten).toBe(1024);
    });
  });

  describe("postBrowserResult", () => {
    test("sends correct URL and body fields", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postBrowserResult({
        requestId: "req-4",
        content: '{"result": true}',
        isError: false,
      });

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/host-browser-result");

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-4");
      expect(body.content).toBe('{"result": true}');
    });
  });

  describe("postCuResult", () => {
    test("sends correct URL and body fields", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postCuResult({
        requestId: "req-5",
        screenshot: "base64screenshot",
        screenshotWidthPx: 1920,
        screenshotHeightPx: 1080,
        screenWidthPt: 1920,
        screenHeightPt: 1080,
        executionResult: "done",
      });

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/host-cu-result");

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-5");
      expect(body.screenshot).toBe("base64screenshot");
      expect(body.screenshotWidthPx).toBe(1920);
    });
  });

  describe("postAppControlResult", () => {
    test("sends correct URL and body fields", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      const result = await poster.postAppControlResult({
        requestId: "req-6",
        state: "running",
        pngBase64: "base64png",
        windowBounds: { x: 0, y: 0, width: 800, height: 600 },
        executionResult: "ok",
      });

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe(
        "http://127.0.0.1:9000/v1/host-app-control-result",
      );

      const body = JSON.parse(req.body!);
      expect(body.requestId).toBe("req-6");
      expect(body.state).toBe("running");
      expect(body.windowBounds).toEqual({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      });
    });
  });

  describe("pullTransferContent", () => {
    test("returns buffer on success", async () => {
      const payload = Buffer.from("file-bytes-here");
      const { fetchFn, captured } = createBinaryMockFetch(200, payload);
      const poster = makePoster(fetchFn);

      const buf = await poster.pullTransferContent("xfer-1");

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString()).toBe("file-bytes-here");

      const req = captured[0];
      expect(req.url).toBe(
        "http://127.0.0.1:9000/v1/transfers/xfer-1/content",
      );
      expect(req.method).toBe("GET");
      expect(req.headers["Authorization"]).toBe("Bearer test-token");
      expect(req.headers["X-Vellum-Client-Id"]).toBe(FAKE_DEVICE_ID);
    });

    test("returns empty buffer on non-2xx", async () => {
      const { fetchFn } = createBinaryMockFetch(404, Buffer.alloc(0));
      const poster = makePoster(fetchFn);

      const buf = await poster.pullTransferContent("xfer-missing");

      expect(buf.length).toBe(0);
    });

    test("URL-encodes the transfer ID", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(
        200,
        Buffer.from("ok"),
      );
      const poster = makePoster(fetchFn);

      await poster.pullTransferContent("id/with special&chars");

      expect(captured[0].url).toBe(
        "http://127.0.0.1:9000/v1/transfers/id%2Fwith%20special%26chars/content",
      );
    });
  });

  describe("pushTransferContent", () => {
    test("sends binary data with correct headers", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);
      const data = Buffer.from("binary-payload");

      const result = await poster.pushTransferContent(
        "xfer-2",
        data,
        "abc123sha256",
      );

      expect(result).toBe(true);
      const req = captured[0];
      expect(req.url).toBe(
        "http://127.0.0.1:9000/v1/transfers/xfer-2/content",
      );
      expect(req.method).toBe("PUT");
      expect(req.headers["Content-Type"]).toBe("application/octet-stream");
      expect(req.headers["X-Transfer-SHA256"]).toBe("abc123sha256");
      expect(req.headers["Authorization"]).toBe("Bearer test-token");
    });

    test("returns false on non-2xx", async () => {
      const { fetchFn } = createMockFetch(500);
      const poster = makePoster(fetchFn);

      const result = await poster.pushTransferContent(
        "xfer-3",
        Buffer.from("x"),
        "sha",
      );

      expect(result).toBe(false);
    });
  });

  describe("error handling", () => {
    test("returns false on non-2xx status", async () => {
      const { fetchFn } = createMockFetch(500);
      const poster = makePoster(fetchFn);

      const result = await poster.postBashResult({
        requestId: "req-err",
        stdout: "",
      });

      expect(result).toBe(false);
    });

    test("returns false when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makePoster(throwingFetch);

      const result = await poster.postBashResult({
        requestId: "req-throw",
        stdout: "",
      });

      expect(result).toBe(false);
    });

    test("pullTransferContent returns empty buffer when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makePoster(throwingFetch);

      const buf = await poster.pullTransferContent("xfer-throw");

      expect(buf.length).toBe(0);
    });

    test("pushTransferContent returns false when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makePoster(throwingFetch);

      const result = await poster.pushTransferContent(
        "xfer-throw",
        Buffer.from("x"),
        "sha",
      );

      expect(result).toBe(false);
    });
  });

  describe("configuration", () => {
    test("uses custom gatewayHost when provided", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn, {
        gatewayHost: "192.168.1.100",
        gatewayPort: 8080,
      });

      await poster.postBashResult({ requestId: "req-host", stdout: "" });

      expect(captured[0].url).toBe(
        "http://192.168.1.100:8080/v1/host-bash-result",
      );
    });

    test("defaults gatewayHost to 127.0.0.1", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makePoster(fetchFn);

      await poster.postBashResult({ requestId: "req-default", stdout: "" });

      expect(captured[0].url).toStartWith("http://127.0.0.1:9000/");
    });
  });
});
