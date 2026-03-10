/**
 * HTTP route handlers for exporting audit data and daemon log files.
 *
 * These endpoints allow clients (e.g. macOS Export Logs) to retrieve
 * audit database records and daemon log files via HTTP instead of
 * requiring direct filesystem access.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { desc } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { toolInvocations } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { getDataDir, getRootDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("log-export-routes");

// ---------------------------------------------------------------------------
// Audit data export
// ---------------------------------------------------------------------------

/**
 * Return recent tool invocation records as a JSON array.
 * Accepts an optional `limit` in the request body (default 1000).
 */
async function handleAuditDataExport(body: {
  limit?: number;
}): Promise<Response> {
  try {
    const limit = body.limit ?? 1000;
    const db = getDb();
    const rows = db
      .select()
      .from(toolInvocations)
      .orderBy(desc(toolInvocations.createdAt))
      .limit(limit)
      .all();

    log.info({ count: rows.length }, "Audit data export completed");
    return Response.json({ success: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export audit data");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to export audit data: ${message}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Daemon logs export
// ---------------------------------------------------------------------------

/** Maximum total payload size for log file contents (10 MB). */
const MAX_LOG_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Return daemon log file contents as a JSON object mapping filenames to
 * their text content. Reads from the daemon rotating log directory
 * (~/.vellum/workspace/data/logs/) and includes the daemon stderr log
 * (~/.vellum/daemon-stderr.log) when present.
 */
async function handleDaemonLogsExport(): Promise<Response> {
  try {
    const files: Record<string, string> = {};
    let totalBytes = 0;

    // Rotating daemon logs
    const logsDir = join(getDataDir(), "logs");
    if (existsSync(logsDir)) {
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        const filePath = join(logsDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;
          if (totalBytes + stat.size > MAX_LOG_PAYLOAD_BYTES) continue;
          files[entry] = readFileSync(filePath, "utf-8");
          totalBytes += stat.size;
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Daemon stderr log
    const stderrPath = join(getRootDir(), "daemon-stderr.log");
    if (existsSync(stderrPath)) {
      try {
        const stat = statSync(stderrPath);
        if (totalBytes + stat.size <= MAX_LOG_PAYLOAD_BYTES) {
          files["daemon-stderr.log"] = readFileSync(stderrPath, "utf-8");
        }
      } catch {
        // Skip if unreadable
      }
    }

    log.info(
      { fileCount: Object.keys(files).length, totalBytes },
      "Daemon logs export completed",
    );
    return Response.json({ success: true, files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export daemon logs");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to export daemon logs: ${message}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function logExportRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "export/audit-data",
      method: "POST",
      policyKey: "export/audit-data",
      handler: async ({ req }) => {
        const body = (await req.json()) as { limit?: number };
        return handleAuditDataExport(body);
      },
    },
    {
      endpoint: "export/daemon-logs",
      method: "POST",
      policyKey: "export/daemon-logs",
      handler: async () => {
        return handleDaemonLogsExport();
      },
    },
  ];
}
