import { afterEach, describe, expect, mock, test } from "bun:test";
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

/** Status may be a list: one entry per call, with the last entry repeating. */
function createMockFetch(
  status: number | number[] = 200,
  responseBody: unknown = { accepted: true },
) {
  const statuses = Array.isArray(status) ? status : [status];
  const captured: CapturedRequest[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const callStatus = statuses[Math.min(captured.length, statuses.length - 1)];
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
      status: callStatus,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn: fetchFn as typeof globalThis.fetch, captured };
}

/** Status may be a list: one entry per call, with the last entry repeating. */
function createBinaryMockFetch(status: number | number[], data: Buffer) {
  const statuses = Array.isArray(status) ? status : [status];
  const captured: CapturedRequest[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const callStatus = statuses[Math.min(captured.length, statuses.length - 1)];
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
      status: callStatus,
      headers: { "Content-Type": "application/octet-stream" },
    });
  };
  return { fetchFn: fetchFn as typeof globalThis.fetch, captured };
}

function makeLocalPoster(fetchFn: typeof globalThis.fetch, port = 9000, token = "test-token") {
  return new HostProxyPoster({
    endpointBase: `http://127.0.0.1:${port}/v1`,
    authHeaders: () => ({ Authorization: `Bearer ${token}` }),
    fetch: fetchFn,
  });
}

function makeCloudPoster(fetchFn: typeof globalThis.fetch, runtimeUrl = "https://platform.vellum.ai", assistantId = "asst-123", sessionToken = "session-tok") {
  return new HostProxyPoster({
    endpointBase: `${runtimeUrl}/v1/assistants/${assistantId}`,
    authHeaders: () => ({ "X-Session-Token": sessionToken }),
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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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

  describe("postPresence", () => {
    test("sends correct URL, method, headers, and body", async () => {
      const { fetchFn, captured } = createMockFetch(200, { recorded: true });
      const poster = makeLocalPoster(fetchFn);

      const result = await poster.postPresence({ state: "active" });

      expect(result).toBe(true);
      expect(captured).toHaveLength(1);

      const req = captured[0];
      expect(req.url).toBe("http://127.0.0.1:9000/v1/clients/presence");
      expect(req.method).toBe("POST");
      expect(req.headers["Content-Type"]).toBe("application/json");
      expect(req.headers["X-Vellum-Client-Id"]).toBe(FAKE_DEVICE_ID);

      const body = JSON.parse(req.body!);
      expect(body.state).toBe("active");
    });

    test("returns false without throwing when the daemon lacks the route", async () => {
      const { fetchFn } = createMockFetch(404);
      const poster = makeLocalPoster(fetchFn);

      const result = await poster.postPresence({ state: "idle" });

      expect(result).toBe(false);
    });

    test("returns false when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makeLocalPoster(throwingFetch);

      const result = await poster.postPresence({ state: "away" });

      expect(result).toBe(false);
    });

    test("treats an accepted but unrecorded report as a failure", async () => {
      // The daemon answers 200 with recorded false when it discarded the
      // report. Scoring that as success is the silent death of the feature:
      // every post accepted, nothing recorded, nothing logged.
      const { fetchFn } = createMockFetch(200, { recorded: false });
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
    });

    test("returns false when the response omits recorded", async () => {
      const { fetchFn } = createMockFetch(200, { accepted: true });
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
    });

    test("returns false without throwing on a malformed body", async () => {
      const { fetchFn } = createMockFetch(200, "<html>not json</html>");
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
    });

    test("returns false when the body is a bare JSON null", async () => {
      const { fetchFn } = createMockFetch(200, null);
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
    });
  });

  describe("result posts ignore the response body", () => {
    // The presence body parse must not have leaked into the generic path:
    // every other endpoint still scores purely on the status.
    test("a 2xx with an unrelated body still counts as success", async () => {
      const { fetchFn } = createMockFetch(200, { recorded: false });
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postBashResult({ requestId: "r1" })).toBe(true);
      expect(await poster.postFileResult({ requestId: "f1" })).toBe(true);
    });

    test("a 2xx with a malformed body still counts as success", async () => {
      const { fetchFn } = createMockFetch(200, "<html>not json</html>");
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postBashResult({ requestId: "r1" })).toBe(true);
    });
  });

  describe("pullTransferContent", () => {
    test("returns buffer on success", async () => {
      const payload = Buffer.from("file-bytes-here");
      const { fetchFn, captured } = createBinaryMockFetch(200, payload);
      const poster = makeLocalPoster(fetchFn);

      const buf = await poster.pullTransferContent("xfer-1");

      expect(buf).not.toBeNull();
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf!.toString()).toBe("file-bytes-here");

      const req = captured[0];
      expect(req.url).toBe(
        "http://127.0.0.1:9000/v1/transfers/xfer-1/content",
      );
      expect(req.method).toBe("GET");
      expect(req.headers["Authorization"]).toBe("Bearer test-token");
      expect(req.headers["X-Vellum-Client-Id"]).toBe(FAKE_DEVICE_ID);
    });

    test("returns null on non-2xx", async () => {
      const { fetchFn } = createBinaryMockFetch(404, Buffer.alloc(0));
      const poster = makeLocalPoster(fetchFn);

      const buf = await poster.pullTransferContent("xfer-missing");

      expect(buf).toBeNull();
    });

    test("URL-encodes the transfer ID", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(
        200,
        Buffer.from("ok"),
      );
      const poster = makeLocalPoster(fetchFn);

      await poster.pullTransferContent("id/with special&chars");

      expect(captured[0].url).toBe(
        "http://127.0.0.1:9000/v1/transfers/id%2Fwith%20special%26chars/content",
      );
    });
  });

  describe("pushTransferContent", () => {
    test("sends binary data with correct headers", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makeLocalPoster(fetchFn);
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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(fetchFn);

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
      const poster = makeLocalPoster(throwingFetch);

      const result = await poster.postBashResult({
        requestId: "req-throw",
        stdout: "",
      });

      expect(result).toBe(false);
    });

    test("pullTransferContent returns null when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makeLocalPoster(throwingFetch);

      const buf = await poster.pullTransferContent("xfer-throw");

      expect(buf).toBeNull();
    });

    test("pushTransferContent returns false when fetch throws", async () => {
      const throwingFetch = (async () => {
        throw new Error("network failure");
      }) as unknown as typeof globalThis.fetch;
      const poster = makeLocalPoster(throwingFetch);

      const result = await poster.pushTransferContent(
        "xfer-throw",
        Buffer.from("x"),
        "sha",
      );

      expect(result).toBe(false);
    });
  });

  // -- 401 refresh --------------------------------------------------------

  describe("401 refresh", () => {
    function makeRefreshingPoster(
      fetchFn: typeof globalThis.fetch,
      refresh: () => Promise<string | null>,
    ) {
      let token = "stale-token";
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: `Bearer ${token}` }),
        refreshAuth: async () => {
          const fresh = await refresh();
          if (fresh) {
            token = fresh;
          }
          return fresh;
        },
        fetch: fetchFn,
      });
      return poster;
    }

    test("refreshes and retries once with the new bearer on 401", async () => {
      const { fetchFn, captured } = createMockFetch([401, 200]);
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const result = await poster.postBashResult({ requestId: "r1", stdout: "" });

      expect(result).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
      expect(captured[0].headers["Authorization"]).toBe("Bearer stale-token");
      expect(captured[1].headers["Authorization"]).toBe("Bearer fresh-token");
      expect(captured[1].body).toBe(captured[0].body);
    });

    test("returns false without retrying when refresh fails", async () => {
      const { fetchFn, captured } = createMockFetch([401]);
      const refresh = mock(async () => null);
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const result = await poster.postBashResult({ requestId: "r2", stdout: "" });

      expect(result).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
    });

    test("returns false without retrying when refresh throws", async () => {
      const { fetchFn, captured } = createMockFetch([401]);
      const poster = makeRefreshingPoster(fetchFn, async () => {
        throw new Error("refresh failed");
      });

      const result = await poster.postBashResult({ requestId: "r3", stdout: "" });

      expect(result).toBe(false);
      expect(captured).toHaveLength(1);
    });

    test("returns false after a second 401 without looping", async () => {
      const { fetchFn, captured } = createMockFetch([401, 401]);
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const result = await poster.postBashResult({ requestId: "r4", stdout: "" });

      expect(result).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });

    test("401 without a refresh callback fails with a single request", async () => {
      const { fetchFn, captured } = createMockFetch([401]);
      const poster = makeLocalPoster(fetchFn);

      const result = await poster.postBashResult({ requestId: "r5", stdout: "" });

      expect(result).toBe(false);
      expect(captured).toHaveLength(1);
    });

    // Presence reads the response body, so it takes a different path through
    // the poster than the result POSTs. It has to end up with the same refresh
    // behaviour: a 401 the retry would have cleared must not read as "the
    // daemon has no record of this desktop".
    test("presence refreshes and retries once, scoring the retry's body", async () => {
      const { fetchFn, captured } = createMockFetch([401, 200], {
        recorded: true,
      });
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const result = await poster.postPresence({ state: "active" });

      expect(result).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
      expect(captured[0].headers["Authorization"]).toBe("Bearer stale-token");
      expect(captured[1].headers["Authorization"]).toBe("Bearer fresh-token");
      expect(JSON.parse(captured[1].body!).state).toBe("active");
    });

    test("presence stays false when the retry is accepted but unrecorded", async () => {
      const { fetchFn, captured } = createMockFetch([401, 200], {
        recorded: false,
      });
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
      expect(captured).toHaveLength(2);
    });

    test("presence 401 without a refresh callback fails with a single request", async () => {
      const { fetchFn, captured } = createMockFetch([401], { recorded: true });
      const poster = makeLocalPoster(fetchFn);

      expect(await poster.postPresence({ state: "active" })).toBe(false);
      expect(captured).toHaveLength(1);
    });

    test("transfer GET refreshes and retries once with the new bearer on 401", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(
        [401, 200],
        Buffer.from("file-bytes"),
      );
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const buf = await poster.pullTransferContent("xfer-refresh");

      expect(buf).not.toBeNull();
      expect(buf!.toString()).toBe("file-bytes");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
      expect(captured[0].headers["Authorization"]).toBe("Bearer stale-token");
      expect(captured[1].headers["Authorization"]).toBe("Bearer fresh-token");
      expect(captured[1].url).toBe(captured[0].url);
    });

    test("transfer GET fails after a second 401 without looping", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(
        [401, 401],
        Buffer.alloc(0),
      );
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const buf = await poster.pullTransferContent("xfer-401");

      expect(buf).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });

    test("transfer GET 401 without a refresh callback fails with a single request", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(401, Buffer.alloc(0));
      const poster = makeLocalPoster(fetchFn);

      const buf = await poster.pullTransferContent("xfer-norefresh");

      expect(buf).toBeNull();
      expect(captured).toHaveLength(1);
    });

    test("transfer PUT refreshes and retries once with the new bearer on 401", async () => {
      const { fetchFn, captured } = createMockFetch([401, 200]);
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);
      const data = Buffer.from("binary-payload");

      const result = await poster.pushTransferContent("xfer-put", data, "sha");

      expect(result).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
      expect(captured[0].headers["Authorization"]).toBe("Bearer stale-token");
      expect(captured[1].headers["Authorization"]).toBe("Bearer fresh-token");
      // The Buffer body is replayed unchanged with its integrity header.
      expect(captured[1].rawBody).toEqual(data);
      expect(captured[1].headers["X-Transfer-SHA256"]).toBe("sha");
    });

    test("transfer PUT fails after a second 401 without looping", async () => {
      const { fetchFn, captured } = createMockFetch([401, 401]);
      const refresh = mock(async () => "fresh-token");
      const poster = makeRefreshingPoster(fetchFn, refresh);

      const result = await poster.pushTransferContent(
        "xfer-put-401",
        Buffer.from("x"),
        "sha",
      );

      expect(result).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });

    test("transfer PUT 401 without a refresh callback fails with a single request", async () => {
      const { fetchFn, captured } = createMockFetch([401]);
      const poster = makeLocalPoster(fetchFn);

      const result = await poster.pushTransferContent(
        "xfer-put-norefresh",
        Buffer.from("x"),
        "sha",
      );

      expect(result).toBe(false);
      expect(captured).toHaveLength(1);
    });
  });

  // -- Cloud mode ---------------------------------------------------------

  describe("cloud mode", () => {
    test("uses assistant-scoped URLs for result POSTs", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makeCloudPoster(fetchFn);

      await poster.postBashResult({ requestId: "r1", stdout: "" });

      expect(captured[0].url).toBe(
        "https://platform.vellum.ai/v1/assistants/asst-123/host-bash-result",
      );
    });

    test("uses X-Session-Token header instead of Bearer token", async () => {
      const { fetchFn, captured } = createMockFetch();
      const poster = makeCloudPoster(fetchFn);

      await poster.postBashResult({ requestId: "r1", stdout: "" });

      expect(captured[0].headers["X-Session-Token"]).toBe("session-tok");
      expect(captured[0].headers["Authorization"]).toBeUndefined();
    });

    test("uses assistant-scoped URLs for transfer content", async () => {
      const { fetchFn, captured } = createBinaryMockFetch(200, Buffer.from("ok"));
      const poster = makeCloudPoster(fetchFn);

      await poster.pullTransferContent("xfer-1");

      expect(captured[0].url).toBe(
        "https://platform.vellum.ai/v1/assistants/asst-123/transfers/xfer-1/content",
      );
    });
  });
});
