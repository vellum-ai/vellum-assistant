/**
 * HTTP route handler for exporting audit data and daemon log files.
 *
 * A single POST /v1/export endpoint allows clients (e.g. macOS Export Logs)
 * to retrieve audit database records and daemon log files via HTTP instead
 * of requiring direct filesystem access.
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

/** Maximum total payload size for log file contents (10 MB). */
const MAX_LOG_PAYLOAD_BYTES = 10 * 1024 * 1024;

interface ExportRequestBody {
  auditLimit?: number;
}

interface ExportResponse {
  success: true;
  auditRows: Array<Record<string, unknown>>;
  logFiles: Record<string, string>;
}

/**
 * Collect audit data rows and daemon log file contents into a single
 * response payload. Returns both `auditRows` (tool invocation records)
 * and `logFiles` (filename → text content mapping).
 */
async function handleExport(body: ExportRequestBody): Promise<Response> {
  try {
    // --- Audit data ---
    const limit = body.auditLimit ?? 1000;
    const db = getDb();
    const auditRows = db
      .select()
      .from(toolInvocations)
      .orderBy(desc(toolInvocations.createdAt))
      .limit(limit)
      .all();

    // --- Daemon log files ---
    const logFiles: Record<string, string> = {};
    let totalBytes = 0;

    const logsDir = join(getDataDir(), "logs");
    if (existsSync(logsDir)) {
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        const filePath = join(logsDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;
          if (totalBytes + stat.size > MAX_LOG_PAYLOAD_BYTES) continue;
          logFiles[entry] = readFileSync(filePath, "utf-8");
          totalBytes += stat.size;
        } catch {
          // Skip unreadable files
        }
      }
    }

    const stderrPath = join(getRootDir(), "daemon-stderr.log");
    if (existsSync(stderrPath)) {
      try {
        const stat = statSync(stderrPath);
        if (totalBytes + stat.size <= MAX_LOG_PAYLOAD_BYTES) {
          logFiles["daemon-stderr.log"] = readFileSync(stderrPath, "utf-8");
        }
      } catch {
        // Skip if unreadable
      }
    }

    log.info(
      { auditCount: auditRows.length, logFileCount: Object.keys(logFiles).length, totalBytes },
      "Export completed",
    );

    const payload: ExportResponse = { success: true, auditRows, logFiles };
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to export: ${message}`,
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
      endpoint: "export",
      method: "POST",
      policyKey: "export",
      handler: async ({ req }) => {
        const body = (await req.json()) as ExportRequestBody;
        return handleExport(body);
      },
    },
  ];
}
