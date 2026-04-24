/**
 * HTTP-layer tests for GET /v1/migrations/jobs/:job_id.
 *
 * Covered:
 * - 404 `{ error: { code: "job_not_found" } }` for an unknown id.
 * - `processing` response shape for a job that is still running (runner
 *   blocked on a deferred gate).
 * - `complete` response shape including the runner's `result`.
 * - `failed` response shape — confirms `error_code`, `error` message, and
 *   the optional `upstream_status` field are all populated when the runner
 *   throws a `kFetchBodyError`-tagged error with `upstreamStatus`.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
  invalidateConfigCache: () => {},
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import { migrationJobs } from "../runtime/migrations/job-registry.js";
import { handleMigrationJobStatus } from "../runtime/routes/migration-routes.js";

const kFetchBodyError = Symbol.for("vellum.migrationImport.fetchBodyError");

/** Spin the microtask queue so `queueMicrotask`-scheduled work runs. */
async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

function makeRequest(): Request {
  return new Request("http://127.0.0.1/v1/migrations/jobs/any");
}

describe("GET /v1/migrations/jobs/:job_id", () => {
  test("404 job_not_found for unknown id", async () => {
    const response = await handleMigrationJobStatus(makeRequest(), {
      job_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("job_not_found");
  });

  test("processing status while the runner is still running", async () => {
    // Keep the runner blocked so the job stays in `running` state.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const job = migrationJobs.startJob("export", async () => {
      await gate;
      return { ok: true };
    });
    // Let `queueMicrotask` flip status from `pending` to `running`.
    await flushMicrotasks();

    try {
      const response = await handleMigrationJobStatus(makeRequest(), {
        job_id: job.id,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        job_id: string;
        type: string;
        status: string;
      };
      expect(body.job_id).toBe(job.id);
      expect(body.type).toBe("export");
      expect(body.status).toBe("processing");
    } finally {
      // Release the runner so the registry's in-flight slot frees up for
      // other tests (and the job transitions to complete cleanly).
      release();
      await flushMicrotasks();
    }
  });

  test("complete status includes the runner's result", async () => {
    const resultPayload = { files_written: 3, manifest: { schema: "vbundle/1" } };

    const job = migrationJobs.startJob("export", async () => resultPayload);
    await flushMicrotasks();

    const response = await handleMigrationJobStatus(makeRequest(), {
      job_id: job.id,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      job_id: string;
      type: string;
      status: string;
      result: unknown;
    };
    expect(body.job_id).toBe(job.id);
    expect(body.type).toBe("export");
    expect(body.status).toBe("complete");
    expect(body.result).toEqual(resultPayload);
  });

  test("failed status exposes error, error_code, and upstream_status", async () => {
    const job = migrationJobs.startJob("import", async () => {
      const err = new Error("upstream hung up") as Error & {
        upstreamStatus?: number;
      };
      (err as unknown as Record<symbol, boolean>)[kFetchBodyError] = true;
      err.upstreamStatus = 502;
      throw err;
    });
    await flushMicrotasks();

    const response = await handleMigrationJobStatus(makeRequest(), {
      job_id: job.id,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      job_id: string;
      type: string;
      status: string;
      error: string;
      error_code: string;
      upstream_status?: number;
    };
    expect(body.job_id).toBe(job.id);
    expect(body.type).toBe("import");
    expect(body.status).toBe("failed");
    expect(body.error).toBe("upstream hung up");
    expect(body.error_code).toBe("fetch_failed");
    expect(body.upstream_status).toBe(502);
  });

  test("failed status omits upstream_status when the runner error has none", async () => {
    const job = migrationJobs.startJob("export", async () => {
      const err = new Error("invalid manifest") as Error & { code: string };
      err.code = "invalid_manifest";
      throw err;
    });
    await flushMicrotasks();

    const response = await handleMigrationJobStatus(makeRequest(), {
      job_id: job.id,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.error).toBe("invalid manifest");
    expect(body.error_code).toBe("invalid_manifest");
    expect(body.upstream_status).toBeUndefined();
  });
});
