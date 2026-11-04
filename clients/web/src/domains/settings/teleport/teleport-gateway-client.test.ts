import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/runtime/local-mode-host";

mock.module("@/generated/api/client.gen", () => ({ client: {} }));
mock.module("@/lib/local-mode", () => ({
  getLocalGatewayUrl: () => "/assistant/__gateway/7821",
}));
mock.module("@/runtime/local-mode-host", () => ({
  fetchGuardianTokenHost: async () => "guardian-token",
}));

const {
  connectLocalGateway,
  createLocalBackup,
  pollLocalExportJob,
  pollLocalMigrationJob,
  startLocalImportFromUrl,
} = await import("./teleport-gateway-client");

const LOCAL = {
  assistantId: "ast-local",
  cloud: "local",
} as unknown as LockfileAssistant;

const GATEWAY_BASE = `${window.location.origin}/assistant/__gateway/7821`;
const GATEWAY = { base: GATEWAY_BASE, token: "gateway-token" };

const BUNDLE_URL =
  "https://storage.googleapis.com/bucket/uploads/org-abc/bundle.vbundle?sig=abc";

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

let originalFetch: typeof globalThis.fetch;
let calls: RecordedCall[];
let routeResponse: () => Response;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  routeResponse = () => Response.json({ success: true, local: {} });
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const headers = new Headers(init?.headers);
      calls.push({
        url: urlStr,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        contentType: headers.get("Content-Type"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (urlStr.endsWith("/auth/token")) {
        return Response.json({ token: "gateway-token" });
      }
      return routeResponse();
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routeCall(path: string): RecordedCall | undefined {
  return calls.find((c) => c.url.endsWith(path));
}

describe("createLocalBackup", () => {
  test("posts to the gateway snapshot route with the minted token", async () => {
    await createLocalBackup(LOCAL);

    const create = calls.find((c) => c.url.endsWith("/v1/backups/create"));
    expect(create).toBeDefined();
    expect(create?.body).toBeNull();
  });

  test("fails on a non-2xx status", async () => {
    routeResponse = () => new Response("boom", { status: 500 });

    await expect(createLocalBackup(LOCAL)).rejects.toThrow(
      "Backup failed (HTTP 500).",
    );
  });

  test("fails on a body reporting failure", async () => {
    routeResponse = () => Response.json({ success: false });

    await expect(createLocalBackup(LOCAL)).rejects.toThrow(
      "Backup reported failure.",
    );
  });
});

describe("connectLocalGateway", () => {
  test("mints one token for the assistant's local gateway", async () => {
    expect(await connectLocalGateway(LOCAL)).toEqual(GATEWAY);
    expect(calls).toEqual([
      {
        url: `${GATEWAY_BASE}/auth/token`,
        method: "POST",
        authorization: "Bearer guardian-token",
        contentType: null,
        body: null,
      },
    ]);
  });
});

describe("startLocalImportFromUrl", () => {
  test("hands the signed URL to the runtime's import-from-gcs route", async () => {
    routeResponse = () =>
      Response.json(
        { job_id: "job-1", status: "pending", type: "import" },
        { status: 202 },
      );

    const result = await startLocalImportFromUrl(GATEWAY, BUNDLE_URL);

    expect(result).toEqual({ ok: true, jobId: "job-1" });
    expect(calls).toHaveLength(1);
    const start = routeCall("/v1/migrations/import-from-gcs");
    expect(start).toEqual({
      url: `${GATEWAY_BASE}/v1/migrations/import-from-gcs`,
      method: "POST",
      authorization: "Bearer gateway-token",
      contentType: "application/json",
      body: { bundle_url: BUNDLE_URL },
    });
    expect(calls.some((c) => c.url.endsWith("/v1/migrations/import"))).toBe(
      false,
    );
  });

  test("reports the runtime's refusal message with its status", async () => {
    routeResponse = () =>
      Response.json(
        {
          error: {
            code: "invalid_bundle_url",
            message: "Invalid bundle URL: host not allowed",
          },
        },
        { status: 400 },
      );

    expect(await startLocalImportFromUrl(GATEWAY, BUNDLE_URL)).toEqual({
      ok: false,
      status: 400,
      message: "Invalid bundle URL: host not allowed",
    });
  });

  test("falls back to the HTTP status when the refusal has no message", async () => {
    routeResponse = () => new Response("Bad Gateway", { status: 502 });

    expect(await startLocalImportFromUrl(GATEWAY, BUNDLE_URL)).toEqual({
      ok: false,
      status: 502,
      message: "Import failed (HTTP 502).",
    });
  });

  test("rejects an accepted response without a job id", async () => {
    routeResponse = () => Response.json({ status: "pending" }, { status: 202 });

    expect(await startLocalImportFromUrl(GATEWAY, BUNDLE_URL)).toEqual({
      ok: false,
      status: 202,
      message: "Import accepted but no job ID returned.",
    });
  });
});

describe("pollLocalMigrationJob", () => {
  test("reads the job from the runtime's job route", async () => {
    routeResponse = () =>
      Response.json({ job_id: "job/1", type: "import", status: "processing" });

    const job = await pollLocalMigrationJob(GATEWAY, "job/1", "import_failed");

    expect(job).toEqual({ status: "processing" });
    expect(calls).toHaveLength(1);
    const poll = routeCall("/v1/migrations/jobs/job%2F1");
    expect(poll?.method).toBe("GET");
    expect(poll?.authorization).toBe("Bearer gateway-token");
  });

  test("returns a completed job", async () => {
    routeResponse = () =>
      Response.json({
        job_id: "job-1",
        type: "import",
        status: "complete",
        result: { success: true },
      });

    expect(
      await pollLocalMigrationJob(GATEWAY, "job-1", "import_failed"),
    ).toEqual({ status: "complete" });
  });

  test("returns a failed job with the runtime's error", async () => {
    routeResponse = () =>
      Response.json({
        job_id: "job-1",
        type: "import",
        status: "failed",
        error: "Bundle exceeds the 16 GiB limit",
        error_code: "validation_failed",
      });

    expect(
      await pollLocalMigrationJob(GATEWAY, "job-1", "import_failed"),
    ).toEqual({ status: "failed", error: "Bundle exceeds the 16 GiB limit" });
  });

  test("treats a 5xx as still processing", async () => {
    routeResponse = () => new Response("unavailable", { status: 503 });

    expect(
      await pollLocalMigrationJob(GATEWAY, "job-1", "import_failed"),
    ).toEqual({ status: "processing" });
  });

  test("throws with the caller's code on a missing job", async () => {
    routeResponse = () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "Job not found" } },
        { status: 404 },
      );

    const error = await pollLocalMigrationJob(
      GATEWAY,
      "job-1",
      "import_failed",
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "import_failed",
      message: "Job status check failed (HTTP 404).",
    });
  });

  test("throws on a body that is not a job status", async () => {
    routeResponse = () => Response.json({ status: "exploded" });

    await expect(
      pollLocalMigrationJob(GATEWAY, "job-1", "import_failed"),
    ).rejects.toThrow("Job status check returned an unexpected response.");
  });
});

describe("pollLocalExportJob", () => {
  test("resolves to the job status", async () => {
    routeResponse = () =>
      Response.json({ job_id: "job-1", type: "export", status: "complete" });

    expect(await pollLocalExportJob(LOCAL, "job-1")).toBe("complete");
  });

  test("throws the runtime's error once the export fails", async () => {
    routeResponse = () =>
      Response.json({
        job_id: "job-1",
        type: "export",
        status: "failed",
        error: "Upload rejected",
        error_code: "upload_failed",
      });

    const error = await pollLocalExportJob(LOCAL, "job-1").catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      code: "export_job_failed",
      message: "Upload rejected",
    });
  });
});
