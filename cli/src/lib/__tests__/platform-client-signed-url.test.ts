import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  platformPollJobStatus,
  platformRequestSignedUrl,
  VersionMismatchError,
  type UnifiedJobStatus,
} from "../platform-client.js";

const PLATFORM_URL = "https://platform.example.test";
const VAK_TOKEN = "vak_test_1234567890"; // API-key path skips org-ID fetch.
const SESSION_TOKEN = "session_test_1234567890"; // non-vak_ triggers org-ID lookup.

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): {
  calls: CapturedCall[];
  fetchMock: typeof globalThis.fetch;
} {
  const calls: CapturedCall[] = [];
  const fetchMock = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const rawHeaders = (init?.headers ?? {}) as
        | Record<string, string>
        | Headers;
      const headers: Record<string, string> = {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k] = v;
        });
      } else {
        Object.assign(headers, rawHeaders);
      }
      let parsedBody: unknown = undefined;
      const b = init?.body;
      if (typeof b === "string") {
        try {
          parsedBody = JSON.parse(b);
        } catch {
          parsedBody = b;
        }
      }
      const call: CapturedCall = {
        url: urlStr,
        method: init?.method ?? "GET",
        headers,
        body: parsedBody,
      };
      calls.push(call);
      return responder(call);
    },
  );
  return { calls, fetchMock: fetchMock as unknown as typeof globalThis.fetch };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("platformRequestSignedUrl", () => {
  test("upload operation with just operation → posts correct body and parses response", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/abc",
          bundle_key: "bundles/abc.tar.gz",
          expires_at: "2026-04-22T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await platformRequestSignedUrl(
      { operation: "upload" },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(result).toEqual({
      url: "https://storage.example/signed/abc",
      bundleKey: "bundles/abc.tar.gz",
      expiresAt: "2026-04-22T00:00:00Z",
      maxContentLength: undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PLATFORM_URL}/v1/migrations/signed-url/`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${VAK_TOKEN}`);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ operation: "upload" });
  });

  test("upload operation with content_length + content_type passes them through", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/xyz",
          bundle_key: "bundles/xyz.tar.gz",
          expires_at: "2026-04-22T01:00:00Z",
          max_content_length: 10_000_000,
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await platformRequestSignedUrl(
      {
        operation: "upload",
        contentType: "application/octet-stream",
        contentLength: 12345,
      },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(result.maxContentLength).toBe(10_000_000);
    expect(calls[0]!.body).toEqual({
      operation: "upload",
      content_type: "application/octet-stream",
      content_length: 12345,
    });
  });

  test("download operation with bundleKey → posts bundle_key and parses response", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/dl-xyz",
          bundle_key: "bundles/xyz.tar.gz",
          expires_at: "2026-04-22T02:00:00Z",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await platformRequestSignedUrl(
      { operation: "download", bundleKey: "bundles/xyz.tar.gz" },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(result.url).toBe("https://storage.example/signed/dl-xyz");
    expect(result.bundleKey).toBe("bundles/xyz.tar.gz");
    expect(calls[0]!.body).toEqual({
      operation: "download",
      bundle_key: "bundles/xyz.tar.gz",
    });
  });

  test("401 → retries once and returns success on the retry", async () => {
    let callCount = 0;
    const { calls, fetchMock } = captureFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ detail: "unauthorized" }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/after-retry",
          bundle_key: "bundles/r.tar.gz",
          expires_at: "2026-04-22T03:00:00Z",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await platformRequestSignedUrl(
      { operation: "upload" },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(result.url).toBe("https://storage.example/signed/after-retry");
    expect(calls).toHaveLength(2);
  });

  test("401 with session token → invalidates org-ID cache and re-fetches on retry", async () => {
    // Session tokens (non-vak_) take the org-ID-fetch path. A 401 here
    // frequently means the cached org ID is stale, so the retry must
    // clear the cache and re-fetch before the second signed-url POST.
    const orgIdCalls: string[] = [];
    const signedUrlCalls: CapturedCall[] = [];
    let orgIdFetchCount = 0;
    let signedUrlCount = 0;

    const fetchMock = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const rawHeaders = (init?.headers ?? {}) as
          | Record<string, string>
          | Headers;
        const headers: Record<string, string> = {};
        if (rawHeaders instanceof Headers) {
          rawHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else {
          Object.assign(headers, rawHeaders);
        }

        if (urlStr.endsWith("/v1/organizations/")) {
          orgIdFetchCount += 1;
          orgIdCalls.push(urlStr);
          const orgId = orgIdFetchCount === 1 ? "org-stale" : "org-fresh";
          return new Response(
            JSON.stringify({ results: [{ id: orgId, name: "Test Org" }] }),
            { status: 200 },
          );
        }

        if (urlStr.endsWith("/v1/migrations/signed-url/")) {
          signedUrlCount += 1;
          let parsedBody: unknown = undefined;
          const b = init?.body;
          if (typeof b === "string") {
            try {
              parsedBody = JSON.parse(b);
            } catch {
              parsedBody = b;
            }
          }
          signedUrlCalls.push({
            url: urlStr,
            method: init?.method ?? "GET",
            headers,
            body: parsedBody,
          });
          if (signedUrlCount === 1) {
            return new Response(JSON.stringify({ detail: "stale org" }), {
              status: 401,
            });
          }
          return new Response(
            JSON.stringify({
              url: "https://storage.example/signed/fresh",
              bundle_key: "bundles/fresh.tar.gz",
              expires_at: "2026-04-22T04:00:00Z",
            }),
            { status: 201 },
          );
        }

        throw new Error(`Unexpected URL: ${urlStr}`);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await platformRequestSignedUrl(
      { operation: "upload" },
      SESSION_TOKEN,
      PLATFORM_URL,
    );

    // Both signed-url attempts were made and the retry succeeded.
    expect(result.url).toBe("https://storage.example/signed/fresh");
    expect(signedUrlCalls).toHaveLength(2);

    // The cache was cleared after the 401, so the org-ID endpoint was
    // hit a second time to fetch a fresh ID before the retry.
    expect(orgIdFetchCount).toBe(2);
    expect(orgIdCalls).toHaveLength(2);

    // The first signed-url POST used the stale org ID, the second used
    // the fresh one.
    expect(signedUrlCalls[0]!.headers["Vellum-Organization-Id"]).toBe(
      "org-stale",
    );
    expect(signedUrlCalls[1]!.headers["Vellum-Organization-Id"]).toBe(
      "org-fresh",
    );

    // Session tokens use X-Session-Token, not Bearer.
    expect(signedUrlCalls[0]!.headers["X-Session-Token"]).toBe(SESSION_TOKEN);
    expect(signedUrlCalls[0]!.headers.Authorization).toBeUndefined();
  });

  test("upload operation with min/max runtime versions → posts them in body", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/v",
          bundle_key: "bundles/v.tar.gz",
          expires_at: "2026-04-22T05:00:00Z",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    await platformRequestSignedUrl(
      {
        operation: "upload",
        minRuntimeVersion: "1.2.3",
        maxRuntimeVersion: null,
      },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(calls[0]!.body).toEqual({
      operation: "upload",
      min_runtime_version: "1.2.3",
      max_runtime_version: null,
    });
  });

  test("download operation with target_runtime_version → posts it in body", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/dl-v",
          bundle_key: "bundles/dl-v.tar.gz",
          expires_at: "2026-04-22T06:00:00Z",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    await platformRequestSignedUrl(
      {
        operation: "download",
        bundleKey: "bundles/dl-v.tar.gz",
        targetRuntimeVersion: "2.0.0",
      },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(calls[0]!.body).toEqual({
      operation: "download",
      bundle_key: "bundles/dl-v.tar.gz",
      target_runtime_version: "2.0.0",
    });
  });

  test("download 422 with version_mismatch body → throws VersionMismatchError", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          reason: "version_mismatch",
          bundle_compat: {
            min_runtime_version: "2.0.0",
            max_runtime_version: "2.5.0",
          },
          target_runtime_version: "1.9.0",
        }),
        { status: 422 },
      );
    });
    globalThis.fetch = fetchMock;

    let caught: unknown;
    try {
      await platformRequestSignedUrl(
        {
          operation: "download",
          bundleKey: "bundles/foo.tar.gz",
          targetRuntimeVersion: "1.9.0",
        },
        VAK_TOKEN,
        PLATFORM_URL,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as VersionMismatchError;
    expect(err.bundleCompat).toEqual({
      min_runtime_version: "2.0.0",
      max_runtime_version: "2.5.0",
    });
    expect(err.targetRuntimeVersion).toBe("1.9.0");
    expect(err.message).toBe(
      "Cannot import: bundle requires runtime 2.0.0–2.5.0, but this runtime is 1.9.0. Update your runtime before importing.",
    );
  });

  test("download 422 with version_mismatch and null max_runtime_version → '+' suffix in message", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          reason: "version_mismatch",
          bundle_compat: {
            min_runtime_version: "3.0.0",
            max_runtime_version: null,
          },
          target_runtime_version: "2.9.0",
        }),
        { status: 422 },
      );
    });
    globalThis.fetch = fetchMock;

    let caught: unknown;
    try {
      await platformRequestSignedUrl(
        {
          operation: "download",
          bundleKey: "bundles/foo.tar.gz",
          targetRuntimeVersion: "2.9.0",
        },
        VAK_TOKEN,
        PLATFORM_URL,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    const err = caught as VersionMismatchError;
    expect(err.message).toBe(
      "Cannot import: bundle requires runtime 3.0.0+, but this runtime is 2.9.0. Update your runtime before importing.",
    );
  });

  test("download 422 with arbitrary body (no reason field) → falls through to generic Error", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ detail: "validation failed" }), {
        status: 422,
      });
    });
    globalThis.fetch = fetchMock;

    let caught: unknown;
    try {
      await platformRequestSignedUrl(
        { operation: "download", bundleKey: "bundles/foo.tar.gz" },
        VAK_TOKEN,
        PLATFORM_URL,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(VersionMismatchError);
    expect((caught as Error).message).toBe("validation failed");
  });

  test("422 is NOT retried after a 401", async () => {
    let callCount = 0;
    const { calls, fetchMock } = captureFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ detail: "unauthorized" }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({
          reason: "version_mismatch",
          bundle_compat: {
            min_runtime_version: "2.0.0",
            max_runtime_version: "2.5.0",
          },
          target_runtime_version: "1.9.0",
        }),
        { status: 422 },
      );
    });
    globalThis.fetch = fetchMock;

    let caught: unknown;
    try {
      await platformRequestSignedUrl(
        {
          operation: "download",
          bundleKey: "bundles/foo.tar.gz",
          targetRuntimeVersion: "1.9.0",
        },
        VAK_TOKEN,
        PLATFORM_URL,
      );
    } catch (err) {
      caught = err;
    }

    expect(calls).toHaveLength(2);
    expect(caught).toBeInstanceOf(VersionMismatchError);
  });

  test("non-422 download path remains unchanged (regression pin on body shape)", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          url: "https://storage.example/signed/dl-xyz",
          bundle_key: "bundles/xyz.tar.gz",
          expires_at: "2026-04-22T02:00:00Z",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await platformRequestSignedUrl(
      { operation: "download", bundleKey: "bundles/xyz.tar.gz" },
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(result.url).toBe("https://storage.example/signed/dl-xyz");
    expect(calls[0]!.body).toEqual({
      operation: "download",
      bundle_key: "bundles/xyz.tar.gz",
    });
  });

  test("5xx error response → surfaces platform detail message", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ detail: "temporarily down" }), {
        status: 503,
      });
    });
    globalThis.fetch = fetchMock;

    await expect(
      platformRequestSignedUrl(
        { operation: "upload" },
        VAK_TOKEN,
        PLATFORM_URL,
      ),
    ).rejects.toThrow(/temporarily down/);
  });
});

describe("platformPollJobStatus", () => {
  test("GET /v1/migrations/jobs/{jobId}/ parses processing", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "job-1",
          type: "export",
          status: "processing",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await platformPollJobStatus(
      "job-1",
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(status).toEqual({
      jobId: "job-1",
      type: "export",
      status: "processing",
    } satisfies UnifiedJobStatus);
    expect(calls[0]!.url).toBe(`${PLATFORM_URL}/v1/migrations/jobs/job-1/`);
    expect(calls[0]!.method).toBe("GET");
  });

  test("parses complete with bundle_key + result", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "job-2",
          type: "export",
          status: "complete",
          bundle_key: "bundles/done.tar.gz",
          result: { files: 42 },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await platformPollJobStatus(
      "job-2",
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(status.status).toBe("complete");
    if (status.status === "complete") {
      expect(status.bundleKey).toBe("bundles/done.tar.gz");
      expect(status.result).toEqual({ files: 42 });
    }
  });

  test("parses failed with error", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "job-3",
          type: "import",
          status: "failed",
          error: "bundle corrupt",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await platformPollJobStatus(
      "job-3",
      VAK_TOKEN,
      PLATFORM_URL,
    );

    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("bundle corrupt");
    }
  });

  test("404 → throws 'Migration job not found'", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("{}", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      platformPollJobStatus("missing", VAK_TOKEN, PLATFORM_URL),
    ).rejects.toThrow(/Migration job not found/);
  });
});
