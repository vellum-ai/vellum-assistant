/**
 * Gateway proxies for the daemon migration export/import endpoints.
 *
 * Follows the same forwarding pattern as upgrade-broadcast-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 *
 * The import handler has two shapes:
 *
 *   1. Raw bytes (octet-stream / multipart) — proxied synchronously. The
 *      caller's connection stays open for the full import duration. Used
 *      by docker teleport, local .vbundle restore, and any client that
 *      uploads the bundle body directly. Unchanged.
 *
 *   2. JSON `{ url }` body — run asynchronously. The gateway generates a
 *      jobId, kicks off the upstream daemon call on an unawaited promise,
 *      and returns `202 Accepted` with `{ job_id, status: "pending" }`
 *      immediately. Callers poll `GET /v1/migrations/import/:jobId/status`
 *      for progress. This keeps the external caller's request short
 *      regardless of bundle size — critical for 8 GB imports where any
 *      LB/ingress timeout along the caller path would otherwise cause
 *      504s while the daemon keeps working.
 *
 *      The gateway → daemon hop remains synchronous: the background task
 *      just holds the daemon request open until the import completes,
 *      then records the outcome in the job map for the caller to poll.
 */

import { randomUUID } from "node:crypto";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("migration-proxy");

/** Timeout for migration requests (60 minutes) — exports/imports can be large (up to 8 GB bundles). */
const MIGRATION_TIMEOUT_MS = 3_600_000;

/**
 * How long a finished (or failed) import job is kept in memory before it's
 * pruned. 30 minutes is long enough for a typical caller-side polling loop
 * to read the terminal state a few times, short enough to bound memory use
 * even under heavy job churn.
 */
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;

/**
 * How often the pruner sweeps the job map. Not timing-critical — jobs that
 * survive a bit past their TTL are fine.
 */
const JOB_PRUNE_INTERVAL_MS = 60 * 1000;

export function createMigrationExportProxyHandler(config: GatewayConfig) {
  return async function handleMigrationExport(req: Request): Promise<Response> {
    const start = performance.now();
    const bodyBuffer = await req.arrayBuffer();

    const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/export`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, MIGRATION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error({ duration }, "Migration export proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration },
        "Migration export proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration },
        "Migration export proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration },
      "Migration export proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}

// ---------------------------------------------------------------------------
// Async import job bookkeeping
// ---------------------------------------------------------------------------

/**
 * Terminal job state mirrors the shape macOS clients already poll on the
 * platform's `/v1/migrations/import/:jobId/status/` endpoint, so a caller
 * library that already knows how to poll there can talk to the gateway
 * with no changes.
 */
export type ImportJobStatus = "pending" | "processing" | "complete" | "failed";

interface ImportJob {
  jobId: string;
  status: ImportJobStatus;
  /** Wall-clock ms when the job was created. Used for idle-pruning. */
  startedAt: number;
  /** Wall-clock ms when the job reached a terminal state. */
  completedAt?: number;
  /** Upstream HTTP status on success. */
  upstreamStatus?: number;
  /** Parsed JSON body the daemon returned on success. */
  result?: unknown;
  /** Terminal-state error message (fetch failure, non-2xx, body parse). */
  error?: string;
}

/**
 * Singleton job map. Module-level so the proxy handler and the status
 * handler share it. The gateway is a single Bun process; no external
 * coordination needed.
 */
const jobs = new Map<string, ImportJob>();
let prunerStarted = false;

function ensurePrunerRunning(): void {
  if (prunerStarted) return;
  prunerStarted = true;
  // Unref'd timer so it doesn't keep the process alive during shutdown.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.completedAt && now - job.completedAt > COMPLETED_JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  }, JOB_PRUNE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/** Test-only: reset the job map between test runs. */
export function _resetImportJobsForTests(): void {
  jobs.clear();
}

/** Test-only: read-only snapshot of the current jobs. */
export function _getImportJobsForTests(): ReadonlyMap<string, ImportJob> {
  return jobs;
}

// ---------------------------------------------------------------------------
// Import proxy — dispatches on Content-Type
// ---------------------------------------------------------------------------

export function createMigrationImportProxyHandler(config: GatewayConfig) {
  return async function handleMigrationImport(req: Request): Promise<Response> {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      return handleAsyncJsonImport(req, config);
    }
    return handleSyncBytesImport(req, config);
  };
}

/**
 * Async path: called by the external caller for URL-based imports. Returns
 * 202 immediately with a job_id; the upstream daemon call runs in the
 * background and the job map is updated when it completes.
 */
async function handleAsyncJsonImport(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  ensurePrunerRunning();

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (err) {
    log.warn({ err }, "Migration import proxy failed to read JSON body");
    return Response.json(
      { error: "Bad Request", message: "Failed to read request body" },
      { status: 400 },
    );
  }

  // The gateway doesn't validate the URL or re-serialize — that's the
  // daemon's job. We just need enough of the headers and the raw body to
  // proxy the request. Log a preview of the path/host if the body parses
  // so ops has something to grep on.
  let previewHost: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "url" in parsed &&
      typeof (parsed as { url: unknown }).url === "string"
    ) {
      try {
        previewHost = new URL((parsed as { url: string }).url).host;
      } catch {
        // Malformed URL — daemon will 400 on it; log without the host.
      }
    }
  } catch {
    // Malformed JSON — daemon will 400 on it; let the error body flow
    // through when the daemon responds.
  }

  const jobId = randomUUID();
  const job: ImportJob = {
    jobId,
    status: "pending",
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  const reqHeaders = stripHopByHop(new Headers(req.headers));
  reqHeaders.delete("host");
  reqHeaders.delete("authorization");
  reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
  reqHeaders.set("content-type", "application/json");
  reqHeaders.set("content-length", String(Buffer.byteLength(bodyText)));

  const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/import`;

  log.info(
    { jobId, previewHost },
    "Migration import proxy: kicking off async URL import",
  );

  // Fire-and-forget the upstream call. Errors are captured in the job map
  // so the caller's next poll surfaces them.
  void runUpstreamImport({
    jobId,
    upstream,
    reqHeaders,
    bodyText,
  });

  return Response.json(
    { job_id: jobId, status: "pending" satisfies ImportJobStatus },
    { status: 202 },
  );
}

/** Helper that holds the daemon request open for the full import duration. */
async function runUpstreamImport(args: {
  jobId: string;
  upstream: string;
  reqHeaders: Headers;
  bodyText: string;
}): Promise<void> {
  const { jobId, upstream, reqHeaders, bodyText } = args;
  const start = performance.now();

  const job = jobs.get(jobId);
  if (job) job.status = "processing";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, MIGRATION_TIMEOUT_MS);

  try {
    // NOTE: `fetch` resolves on headers, not on full body delivery. Keep
    // the abort timer alive across `response.json()` so a partial-body
    // stall on the upstream side still aborts and we transition the job
    // to `failed` — otherwise a mid-body drop would leave the job pinned
    // at `processing` indefinitely and pollers would spin forever.
    // The timer is cleared in the `finally` below, which fires after the
    // body has been fully consumed (or the abort has fired).
    const response = await fetchImpl(upstream, {
      method: "POST",
      headers: reqHeaders,
      body: bodyText,
      signal: controller.signal,
    });

    const duration = Math.round(performance.now() - start);

    // The daemon always returns JSON for this path (success OR structured
    // failure shapes). Parse and record; treat a parse failure as a job
    // failure since the caller can't meaningfully poll on bytes.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      markJobFailed(
        jobId,
        response.status,
        `Invalid JSON from assistant: ${errMessage(err)}`,
      );
      log.error(
        { jobId, status: response.status, duration, err },
        "Migration import async: failed to parse daemon JSON response",
      );
      return;
    }

    if (response.status >= 200 && response.status < 300) {
      // Daemon returns HTTP 200 for some logical-failure shapes — notably
      // `{ success: false, reason: "validation_failed", errors: [...] }`
      // for bundles that failed manifest / hash validation. Callers that
      // gate on `status === "complete"` would otherwise report success
      // for an import that actually failed. Inspect the body before
      // declaring victory.
      if (isLogicalFailureBody(parsed)) {
        const errorMessage =
          extractErrorMessage(parsed) ?? "Import reported failure";
        markJobFailed(jobId, response.status, errorMessage, parsed);
        log.warn(
          { jobId, status: response.status, duration, error: errorMessage },
          "Migration import async: daemon returned 2xx with success=false body",
        );
        return;
      }
      markJobComplete(jobId, response.status, parsed);
      log.info(
        { jobId, status: response.status, duration },
        "Migration import async: completed",
      );
      return;
    }

    // Non-2xx: the daemon's JSON body is the caller-visible failure. Pull
    // a `reason` / `message` out of it for the `error` field if present,
    // keep the whole body under `result` so nothing is lost.
    const errorMessage =
      extractErrorMessage(parsed) ?? `HTTP ${response.status}`;
    markJobFailed(jobId, response.status, errorMessage, parsed);
    log.warn(
      { jobId, status: response.status, duration, error: errorMessage },
      "Migration import async: daemon returned non-2xx",
    );
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    const message = isTimeout
      ? `Gateway → assistant request timed out after ${MIGRATION_TIMEOUT_MS}ms`
      : `Gateway → assistant request failed: ${errMessage(err)}`;
    markJobFailed(jobId, undefined, message);
    log.error(
      { jobId, duration, err },
      "Migration import async: upstream connection failed",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function markJobComplete(
  jobId: string,
  upstreamStatus: number,
  result: unknown,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "complete";
  job.upstreamStatus = upstreamStatus;
  job.result = result;
  job.completedAt = Date.now();
}

function markJobFailed(
  jobId: string,
  upstreamStatus: number | undefined,
  error: string,
  result?: unknown,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "failed";
  job.upstreamStatus = upstreamStatus;
  job.error = error;
  if (result !== undefined) job.result = result;
  job.completedAt = Date.now();
}

/**
 * The daemon's migration import handler returns HTTP 200 for some logical
 * failures — specifically `{ success: false, reason: "validation_failed",
 * errors: [...] }` when the bundle's manifest / hash checks fail. Those
 * are semantic failures, NOT HTTP-level errors. Detect them so the async
 * job ends up in the `failed` state rather than `complete`.
 */
function isLogicalFailureBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record.success === false;
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (typeof record.reason === "string") return record.reason;
  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sync path: raw-bytes imports (octet-stream / multipart). Unchanged from
 * the previous implementation — the request body IS the bundle, so there's
 * no benefit to running it async (the caller's upload has to stay open
 * anyway).
 */
async function handleSyncBytesImport(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const start = performance.now();
  const bodyBuffer = await req.arrayBuffer();

  const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/import`;

  const reqHeaders = stripHopByHop(new Headers(req.headers));
  reqHeaders.delete("host");
  reqHeaders.delete("authorization");

  reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
  reqHeaders.set("content-length", String(bodyBuffer.byteLength));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, MIGRATION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(upstream, {
      method: "POST",
      headers: reqHeaders,
      body: bodyBuffer,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    const duration = Math.round(performance.now() - start);
    if (err instanceof DOMException && err.name === "TimeoutError") {
      log.error({ duration }, "Migration import proxy upstream timed out");
      return Response.json({ error: "Gateway Timeout" }, { status: 504 });
    }
    log.error(
      { err, duration },
      "Migration import proxy upstream connection failed",
    );
    return Response.json({ error: "Bad Gateway" }, { status: 502 });
  }

  const resHeaders = stripHopByHop(new Headers(response.headers));
  const duration = Math.round(performance.now() - start);

  if (response.status >= 400) {
    const body = await response.text();
    log.warn(
      { status: response.status, duration },
      "Migration import proxy upstream error",
    );
    return new Response(body, {
      status: response.status,
      headers: resHeaders,
    });
  }

  log.info(
    { status: response.status, duration },
    "Migration import proxy completed",
  );
  return new Response(response.body, {
    status: response.status,
    headers: resHeaders,
  });
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

/**
 * GET `/v1/migrations/import/:jobId/status` handler.
 *
 * Returns the job's current status on 200, or 404 if the jobId is unknown
 * (never issued, or pruned after the TTL). The response shape deliberately
 * mirrors the platform's existing `/v1/migrations/import/:jobId/status/`
 * endpoint so `PlatformMigrationClient.pollImportStatus` works against
 * either surface with no changes.
 */
export function createMigrationImportStatusProxyHandler(
  _config: GatewayConfig,
) {
  return async function handleMigrationImportStatus(
    _req: Request,
    jobId: string,
  ): Promise<Response> {
    const job = jobs.get(jobId);
    if (!job) {
      return Response.json(
        { error: "Not Found", message: `Unknown import job: ${jobId}` },
        { status: 404 },
      );
    }

    const body: {
      status: ImportJobStatus;
      job_id: string;
      error?: string;
      result?: unknown;
    } = {
      status: job.status,
      job_id: job.jobId,
    };
    if (job.error !== undefined) body.error = job.error;
    if (job.result !== undefined) body.result = job.result;

    return Response.json(body, { status: 200 });
  };
}
