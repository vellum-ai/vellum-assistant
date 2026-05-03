import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEntry } from "../assistant-config.js";
import {
  MigrationInProgressError,
  localRuntimeExportToGcs,
  localRuntimeIdentity,
  localRuntimeImportFromGcs,
  localRuntimePollJobStatus,
} from "../local-runtime-client.js";

const RUNTIME_URL = "http://127.0.0.1:8765";
const TOKEN = "local-bearer-token";

// All tests in this file exercise the local/docker code path (cloud="local"),
// which builds `{runtimeUrl}/v1/migrations/<subpath>` URLs and uses
// guardian-token bearer auth. The platform path (cloud="vellum") is covered
// by `runtime-url.test.ts` (URL construction) and the teleport tests
// (call-site wiring).
const ENTRY: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId"> = {
  cloud: "local",
  runtimeUrl: RUNTIME_URL,
  assistantId: "ast-test-1",
};

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

describe("localRuntimeExportToGcs", () => {
  test("POSTs {upload_url, description} with Bearer auth and returns job_id on 202", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "export-job-1",
          status: "pending",
          type: "export",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await localRuntimeExportToGcs(ENTRY, TOKEN, {
      uploadUrl: "https://storage.example/signed/abc",
      description: "teleport export",
    });

    expect(result.jobId).toBe("export-job-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${RUNTIME_URL}/v1/migrations/export-to-gcs`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({
      upload_url: "https://storage.example/signed/abc",
      description: "teleport export",
    });
  });

  test("omits description when not provided", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({ job_id: "j", status: "pending", type: "export" }),
        { status: 202 },
      );
    });
    globalThis.fetch = fetchMock;

    await localRuntimeExportToGcs(ENTRY, TOKEN, {
      uploadUrl: "https://storage.example/signed/abc",
    });

    expect(calls[0]!.body).toEqual({
      upload_url: "https://storage.example/signed/abc",
    });
  });

  test("409 export_in_progress (nested {error:{code,job_id}}) throws MigrationInProgressError carrying existing job_id", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          error: {
            code: "export_in_progress",
            job_id: "existing-export-42",
          },
        }),
        { status: 409 },
      );
    });
    globalThis.fetch = fetchMock;

    try {
      await localRuntimeExportToGcs(ENTRY, TOKEN, {
        uploadUrl: "https://storage.example/signed/abc",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationInProgressError);
      const mip = err as MigrationInProgressError;
      expect(mip.kind).toBe("export_in_progress");
      expect(mip.existingJobId).toBe("existing-export-42");
    }
  });

  test("409 export_in_progress regression: nested job_id 'abc-123' is surfaced (not empty)", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          error: { code: "export_in_progress", job_id: "abc-123" },
        }),
        { status: 409 },
      );
    });
    globalThis.fetch = fetchMock;

    try {
      await localRuntimeExportToGcs(ENTRY, TOKEN, {
        uploadUrl: "https://storage.example/signed/abc",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationInProgressError);
      const mip = err as MigrationInProgressError;
      expect(mip.existingJobId).toBe("abc-123");
      expect(mip.existingJobId).not.toBe("");
      expect(mip.kind).toBe("export_in_progress");
    }
  });

  test("409 export_in_progress with legacy flat shape is still parsed", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          code: "export_in_progress",
          job_id: "legacy-export-9",
        }),
        { status: 409 },
      );
    });
    globalThis.fetch = fetchMock;

    try {
      await localRuntimeExportToGcs(ENTRY, TOKEN, {
        uploadUrl: "https://storage.example/signed/abc",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationInProgressError);
      const mip = err as MigrationInProgressError;
      expect(mip.kind).toBe("export_in_progress");
      expect(mip.existingJobId).toBe("legacy-export-9");
    }
  });

  test("non-202 non-409 responses throw with status + body", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("boom", { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      localRuntimeExportToGcs(ENTRY, TOKEN, {
        uploadUrl: "https://storage.example/signed/abc",
      }),
    ).rejects.toThrow(/500/);
  });
});

describe("localRuntimeImportFromGcs", () => {
  test("POSTs {bundle_url} with Bearer auth and returns job_id on 202", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "import-job-1",
          status: "pending",
          type: "import",
        }),
        { status: 202 },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await localRuntimeImportFromGcs(ENTRY, TOKEN, {
      bundleUrl: "https://storage.example/signed/dl-xyz",
    });

    expect(result.jobId).toBe("import-job-1");
    expect(calls[0]!.url).toBe(`${RUNTIME_URL}/v1/migrations/import-from-gcs`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({
      bundle_url: "https://storage.example/signed/dl-xyz",
    });
  });

  test("409 import_in_progress (nested {error:{code,job_id}}) throws MigrationInProgressError carrying existing job_id", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          error: {
            code: "import_in_progress",
            job_id: "existing-import-7",
          },
        }),
        { status: 409 },
      );
    });
    globalThis.fetch = fetchMock;

    try {
      await localRuntimeImportFromGcs(ENTRY, TOKEN, {
        bundleUrl: "https://storage.example/signed/dl-xyz",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationInProgressError);
      const mip = err as MigrationInProgressError;
      expect(mip.kind).toBe("import_in_progress");
      expect(mip.existingJobId).toBe("existing-import-7");
    }
  });

  test("409 import_in_progress with legacy flat shape is still parsed", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          code: "import_in_progress",
          job_id: "legacy-import-2",
        }),
        { status: 409 },
      );
    });
    globalThis.fetch = fetchMock;

    try {
      await localRuntimeImportFromGcs(ENTRY, TOKEN, {
        bundleUrl: "https://storage.example/signed/dl-xyz",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationInProgressError);
      const mip = err as MigrationInProgressError;
      expect(mip.kind).toBe("import_in_progress");
      expect(mip.existingJobId).toBe("legacy-import-2");
    }
  });
});

describe("localRuntimePollJobStatus", () => {
  test("GETs /v1/migrations/jobs/{jobId} with Bearer auth and parses processing", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "poll-1",
          type: "export",
          status: "processing",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await localRuntimePollJobStatus(ENTRY, TOKEN, "poll-1");

    expect(status).toEqual({
      jobId: "poll-1",
      type: "export",
      status: "processing",
    });
    expect(calls[0]!.url).toBe(`${RUNTIME_URL}/v1/migrations/jobs/poll-1`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("parses complete with bundle_key", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "poll-2",
          type: "export",
          status: "complete",
          bundle_key: "bundles/x.tar.gz",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await localRuntimePollJobStatus(ENTRY, TOKEN, "poll-2");

    expect(status.status).toBe("complete");
    if (status.status === "complete") {
      expect(status.bundleKey).toBe("bundles/x.tar.gz");
    }
  });

  test("parses failed with error", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "poll-3",
          type: "import",
          status: "failed",
          error: "corrupted bundle",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await localRuntimePollJobStatus(ENTRY, TOKEN, "poll-3");

    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toBe("corrupted bundle");
    }
  });

  test("404 → throws 'Migration job not found'", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("{}", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      localRuntimePollJobStatus(ENTRY, TOKEN, "missing"),
    ).rejects.toThrow(/Migration job not found/);
  });
});

// ---------------------------------------------------------------------------
// Platform-managed assistants (cloud="vellum") route through the platform's
// wildcard runtime proxy at `/v1/assistants/<id>/migrations/...` with
// platform-token auth (NOT guardian-token bearer). This block asserts the
// actual URL and headers built by the helpers — not mocked, not abstracted.
// Regression guard for the routing bug fixed in this PR.
// ---------------------------------------------------------------------------
const VELLUM_ENTRY: Pick<
  AssistantEntry,
  "cloud" | "runtimeUrl" | "assistantId"
> = {
  cloud: "vellum",
  runtimeUrl: "https://platform.vellum.ai",
  assistantId: "11111111-2222-3333-4444-555555555555",
};
// `vak_` prefix bypasses `fetchOrganizationId` (org-scoped API keys); the
// auth header collapses to a single `Authorization: Bearer vak_...` so this
// test stays free of network mocks.
const VAK_TOKEN = "vak_platform-token";

describe("vellum-cloud routing through wildcard proxy", () => {
  test("export-to-gcs URL has /v1/assistants/<id>/migrations/ prefix and uses platform-token bearer (no guardian)", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({ job_id: "wp-export-1", status: "pending" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await localRuntimeExportToGcs(VELLUM_ENTRY, VAK_TOKEN, {
      uploadUrl: "https://storage.example/signed/x",
      description: "teleport export",
    });

    expect(result.jobId).toBe("wp-export-1");
    expect(calls[0]!.url).toBe(
      `https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/export-to-gcs`,
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${VAK_TOKEN}`);
    expect(calls[0]!.body).toEqual({
      upload_url: "https://storage.example/signed/x",
      description: "teleport export",
    });
  });

  test("import-from-gcs URL has /v1/assistants/<id>/migrations/ prefix", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({ job_id: "wp-import-1", status: "pending" }),
        { status: 202 },
      );
    });
    globalThis.fetch = fetchMock;

    await localRuntimeImportFromGcs(VELLUM_ENTRY, VAK_TOKEN, {
      bundleUrl: "https://storage.example/download/y",
    });

    expect(calls[0]!.url).toBe(
      `https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/import-from-gcs`,
    );
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${VAK_TOKEN}`);
  });

  test("jobs/<id> URL has /v1/assistants/<id>/migrations/ prefix (NOT the dedicated platform endpoint)", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          job_id: "wp-export-1",
          status: "complete",
          type: "export",
          bundle_key: "exports/org-1/x.vbundle",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const status = await localRuntimePollJobStatus(
      VELLUM_ENTRY,
      VAK_TOKEN,
      "wp-export-1",
    );

    expect(calls[0]!.url).toBe(
      `https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/jobs/wp-export-1`,
    );
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${VAK_TOKEN}`);
    expect(status.status).toBe("complete");
    if (status.status === "complete") {
      expect(status.bundleKey).toBe("exports/org-1/x.vbundle");
    }
  });
});

describe("localRuntimeIdentity", () => {
  test("local entry: GETs /v1/health with Bearer auth and returns the version", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(
        JSON.stringify({
          status: "healthy",
          timestamp: "2025-01-01T00:00:00Z",
          version: "0.6.5",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    globalThis.fetch = fetchMock;

    const result = await localRuntimeIdentity(ENTRY, TOKEN);

    expect(result.version).toBe("0.6.5");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${RUNTIME_URL}/v1/health`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("GETs /v1/health, not /v1/identity (works on pre-onboarding runtimes)", async () => {
    // Regression guard: /v1/identity reads IDENTITY.md (written during
    // onboarding, NOT hatch) and 404s on freshly-hatched targets. /v1/health
    // returns the version field unconditionally, so it's the right source.
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ version: "0.7.0" }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock;

    await localRuntimeIdentity(ENTRY, TOKEN);

    expect(calls[0]!.url.endsWith("/v1/health")).toBe(true);
    expect(calls[0]!.url).not.toContain("/v1/identity");
  });

  test("vellum entry: GETs /v1/assistants/<id>/health through the wildcard proxy", async () => {
    const { calls, fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ version: "0.7.2" }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock;

    const result = await localRuntimeIdentity(VELLUM_ENTRY, VAK_TOKEN);

    expect(result.version).toBe("0.7.2");
    expect(calls[0]!.url).toBe(
      `https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/health`,
    );
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${VAK_TOKEN}`);
  });

  test("non-2xx status throws with status + statusText", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response("nope", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });
    globalThis.fetch = fetchMock;

    await expect(localRuntimeIdentity(ENTRY, TOKEN)).rejects.toThrow(
      /Failed to fetch runtime identity: 503/,
    );
  });

  test("missing version in body throws", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({}), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    await expect(localRuntimeIdentity(ENTRY, TOKEN)).rejects.toThrow(
      /Runtime identity response missing version/,
    );
  });

  test("non-string version in body throws", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ version: 123 }), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    await expect(localRuntimeIdentity(ENTRY, TOKEN)).rejects.toThrow(
      /Runtime identity response missing version/,
    );
  });

  test("empty-string version in body throws", async () => {
    const { fetchMock } = captureFetch(() => {
      return new Response(JSON.stringify({ version: "" }), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    await expect(localRuntimeIdentity(ENTRY, TOKEN)).rejects.toThrow(
      /Runtime identity response missing version/,
    );
  });

  // ---------------------------------------------------------------------
  // 401-retry parity with platformRequestSignedUrl (Codex P2 regression
  // guard). localRuntimeIdentity is the first network call in the
  // backup/teleport export flow for vellum-cloud assistants, so a stale
  // Vellum-Organization-Id cache entry would surface as a hard abort
  // before any other helper got a chance to clear the cache and retry.
  // ---------------------------------------------------------------------

  test("vellum entry: retries once after 401 with a fresh org-ID lookup", async () => {
    // Use a non-vak session token so authHeaders fetches + caches an org ID.
    const SESSION_TOKEN = "session-abcdef";
    const PLATFORM_URL = "https://platform.vellum.ai";
    const ASSISTANT_ID = "11111111-2222-3333-4444-555555555555";

    let healthCalls = 0;
    const orgIdFetchedAs: string[] = [];

    const fetchMock = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/v1/organizations/")) {
        // Each org-ID fetch returns a different ID to prove that the
        // second health request DID re-resolve the org rather than
        // reuse a stale cache entry.
        orgIdFetchedAs.push(`org-${orgIdFetchedAs.length + 1}`);
        return new Response(
          JSON.stringify({
            results: [{ id: orgIdFetchedAs[orgIdFetchedAs.length - 1]! }],
          }),
          { status: 200 },
        );
      }
      if (urlStr.endsWith(`/v1/assistants/${ASSISTANT_ID}/health`)) {
        healthCalls += 1;
        if (healthCalls === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ version: "0.7.4" }), {
          status: 200,
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await localRuntimeIdentity(
      {
        cloud: "vellum",
        runtimeUrl: PLATFORM_URL,
        assistantId: ASSISTANT_ID,
      },
      SESSION_TOKEN,
    );

    expect(result.version).toBe("0.7.4");
    expect(healthCalls).toBe(2);
    // Two org-ID fetches: the first to satisfy the initial authHeaders
    // call, the second after the 401-driven cache invalidation.
    expect(orgIdFetchedAs).toEqual(["org-1", "org-2"]);
  });

  test("local entry: does NOT retry after 401 (guardian-token refresh is the caller's job via callRuntimeWithAuthRetry)", async () => {
    let identityCalls = 0;
    const fetchMock = mock(async () => {
      identityCalls += 1;
      return new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(localRuntimeIdentity(ENTRY, TOKEN)).rejects.toThrow(
      /Failed to fetch runtime identity: 401/,
    );
    expect(identityCalls).toBe(1);
  });
});
