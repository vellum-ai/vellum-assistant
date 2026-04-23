import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  MigrationInProgressError,
  localRuntimeExportToGcs,
  localRuntimeImportFromGcs,
  localRuntimePollJobStatus,
} from "../local-runtime-client.js";

const RUNTIME_URL = "http://127.0.0.1:8765";
const TOKEN = "local-bearer-token";

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

    const result = await localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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

    await localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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
      await localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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
      await localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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
      await localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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
      localRuntimeExportToGcs(RUNTIME_URL, TOKEN, {
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

    const result = await localRuntimeImportFromGcs(RUNTIME_URL, TOKEN, {
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
      await localRuntimeImportFromGcs(RUNTIME_URL, TOKEN, {
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
      await localRuntimeImportFromGcs(RUNTIME_URL, TOKEN, {
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

    const status = await localRuntimePollJobStatus(
      RUNTIME_URL,
      TOKEN,
      "poll-1",
    );

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

    const status = await localRuntimePollJobStatus(
      RUNTIME_URL,
      TOKEN,
      "poll-2",
    );

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

    const status = await localRuntimePollJobStatus(
      RUNTIME_URL,
      TOKEN,
      "poll-3",
    );

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
      localRuntimePollJobStatus(RUNTIME_URL, TOKEN, "missing"),
    ).rejects.toThrow(/Migration job not found/);
  });
});
