/**
 * Log export HTTP endpoint for the CES managed service.
 *
 * Exposes a single `GET /v1/logs/export` endpoint that collects CES log
 * files, archives them as a tar.gz, and returns the archive. The gateway
 * calls this endpoint to collect CES logs alongside daemon and gateway
 * logs during a diagnostic log export.
 *
 * Auth: Requires a `CES_SERVICE_TOKEN` bearer token in the
 * `Authorization` header (same token used for credential CRUD).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { LOG_FILE_PATTERN } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cumulative size of collected log files (5 MB). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Validate the Authorization header against the configured service token.
 * Returns an error Response if auth fails, or null if auth succeeds.
 */
function checkAuth(req: Request, serviceToken: string): Response | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") {
    return new Response(
      JSON.stringify({ error: "Invalid Authorization header format. Expected: Bearer <token>" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const provided = Buffer.from(parts[1]!);
  const expected = Buffer.from(serviceToken);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new Response(
      JSON.stringify({ error: "Invalid service token" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Try to handle a log export request. Returns a Response if the request
 * matches `GET /v1/logs/export`, or null if it doesn't match (allowing the
 * caller to fall through to other routes).
 */
export async function handleLogExportRoute(
  req: Request,
  logDir: string,
): Promise<Response | null> {
  const url = new URL(req.url);

  // Only handle GET /v1/logs/export
  if (url.pathname !== "/v1/logs/export") {
    return null;
  }

  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  // Auth check
  const serviceToken = process.env["CES_SERVICE_TOKEN"] ?? "";
  if (!serviceToken) {
    return new Response(
      JSON.stringify({ error: "CES_SERVICE_TOKEN not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const authError = checkAuth(req, serviceToken);
  if (authError) return authError;

  // Parse optional time range query params
  const startTimeParam = url.searchParams.get("startTime");
  const endTimeParam = url.searchParams.get("endTime");
  const startTime = startTimeParam ? Number(startTimeParam) : undefined;
  const endTime = endTimeParam ? Number(endTimeParam) : undefined;

  const staging = mkdtempSync(join(tmpdir(), "ces-log-export-"));

  try {
    const logsStaging = join(staging, "ces-logs");
    mkdirSync(logsStaging, { recursive: true });

    let totalBytes = 0;
    let filesCollected = 0;

    if (existsSync(logDir)) {
      const entries = readdirSync(logDir);
      for (const entry of entries) {
        const dateMatch = LOG_FILE_PATTERN.exec(entry);
        if (!dateMatch) continue;

        // Filter by date when startTime/endTime are provided.
        // Parse the date from the filename and compare start-of-day / end-of-day
        // against the time bounds.
        const fileDateStr = dateMatch[1]!;
        const fileDayStartMs = new Date(fileDateStr + "T00:00:00.000Z").getTime();
        const fileDayEndMs = new Date(fileDateStr + "T23:59:59.999Z").getTime();

        if (startTime !== undefined && fileDayEndMs < startTime) continue; // entire day before range
        if (endTime !== undefined && fileDayStartMs > endTime) continue; // entire day after range

        const filePath = join(logDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;
          if (totalBytes + stat.size > MAX_LOG_BYTES) continue;

          // Copy the file to the staging directory via Bun.file for efficiency,
          // but fall back to sync fs for portability in the spawnSync-based flow.
          const content = await Bun.file(filePath).arrayBuffer();
          writeFileSync(join(logsStaging, entry), Buffer.from(content));
          totalBytes += stat.size;
          filesCollected++;
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Always write a manifest so the consumer knows what was collected
    const manifest = {
      type: "ces-log-export",
      exportedAt: new Date().toISOString(),
      filesCollected,
      totalBytes,
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    };
    writeFileSync(
      join(staging, "ces-export-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // Create tar.gz archive of the staging directory
    const proc = spawnSync("tar", ["czf", "-", "-C", staging, "."], {
      maxBuffer: MAX_LOG_BYTES * 2, // allow headroom for tar overhead
      timeout: 30_000,
    });

    if (proc.status !== 0) {
      const stderr = proc.stderr
        ? Buffer.isBuffer(proc.stderr)
          ? proc.stderr.toString("utf-8")
          : String(proc.stderr)
        : "unknown error";
      return new Response(
        JSON.stringify({ error: "Failed to create archive", detail: stderr }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const archiveBuffer = Buffer.isBuffer(proc.stdout)
      ? proc.stdout
      : Buffer.from(proc.stdout);

    return new Response(
      archiveBuffer.buffer.slice(
        archiveBuffer.byteOffset,
        archiveBuffer.byteOffset + archiveBuffer.byteLength,
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="ces-logs.tar.gz"',
          "Content-Length": String(archiveBuffer.byteLength),
        },
      },
    );
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
