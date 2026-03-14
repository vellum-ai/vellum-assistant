/**
 * HTTP route handler for exporting audit data and daemon log files.
 *
 * A single POST /v1/export endpoint allows clients (e.g. macOS Export Logs)
 * to retrieve audit database records and daemon log files via HTTP instead
 * of requiring direct filesystem access.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

import { desc } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { toolInvocations } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import {
  getDataDir,
  getRootDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
} from "../../util/platform.js";
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
  configSnapshot?: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
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

    // --- Sanitized config snapshot ---
    const configSnapshot = readSanitizedConfig();

    // --- Workspace files ---
    const workspaceFiles = collectWorkspaceFiles();

    log.info(
      {
        auditCount: auditRows.length,
        logFileCount: Object.keys(logFiles).length,
        totalBytes,
        hasConfig: configSnapshot !== undefined,
        workspaceFileCount: Object.keys(workspaceFiles).length,
      },
      "Export completed",
    );

    const payload: ExportResponse = {
      success: true,
      auditRows,
      logFiles,
      configSnapshot,
      workspaceFiles,
    };
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export");
    return httpError("INTERNAL_ERROR", `Failed to export: ${message}`, 500);
  }
}

/** Directory prefixes to skip when collecting workspace files. */
const WORKSPACE_SKIP_DIRS = new Set(["embedding-models", "data/qdrant"]);

/** Files at the workspace root to skip (already covered by sanitized fields). */
const WORKSPACE_SKIP_ROOT_FILES = new Set(["config.json"]);

/** Maximum cumulative size for workspace file contents (10 MB). */
const MAX_WORKSPACE_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Recursively collects files from the workspace directory into a
 * `Record<string, string>` map of relative path to content.
 *
 * - Skips `config.json` at the workspace root (already exported as a
 *   sanitized `configSnapshot`; the raw file contains secrets).
 * - Skips symlinks to prevent reading files outside the workspace.
 * - Skips directories in `WORKSPACE_SKIP_DIRS`.
 * - For `.db` files, shells out to `sqlite3 <path> .dump` and stores the
 *   SQL text output with a `.sql` suffix appended to the key.
 * - Skips binary files (detected via null-byte heuristic).
 * - Stops collecting once `MAX_WORKSPACE_PAYLOAD_BYTES` is reached.
 */
function collectWorkspaceFiles(): Record<string, string> {
  const wsDir = getWorkspaceDir();
  if (!existsSync(wsDir)) return {};

  const result: Record<string, string> = {};
  let totalBytes = 0;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(wsDir, fullPath);

      // Check if this path falls under a skipped directory prefix
      if (
        [...WORKSPACE_SKIP_DIRS].some(
          (prefix) => relPath === prefix || relPath.startsWith(prefix + "/"),
        )
      ) {
        continue;
      }

      // Skip root-level files that are already exported separately
      if (dir === wsDir && WORKSPACE_SKIP_ROOT_FILES.has(entry)) {
        continue;
      }

      try {
        // Use lstatSync to avoid following symlinks
        const stat = lstatSync(fullPath);

        // Skip symlinks — they could point outside the workspace
        if (stat.isSymbolicLink()) continue;

        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!stat.isFile()) continue;

        // Enforce cumulative size cap
        if (totalBytes + stat.size > MAX_WORKSPACE_PAYLOAD_BYTES) continue;

        // SQLite DB handling: dump as SQL text
        if (entry.endsWith(".db")) {
          try {
            const proc = spawnSync("sqlite3", [fullPath, ".dump"], {
              timeout: 10_000,
            });
            if (proc.status === 0 && proc.stdout) {
              const output =
                proc.stdout instanceof Buffer
                  ? proc.stdout.toString("utf-8")
                  : String(proc.stdout);
              result[relPath + ".sql"] = output;
              totalBytes += Buffer.byteLength(output, "utf-8");
            }
          } catch {
            // Skip if dump fails
          }
          continue;
        }

        // Read as UTF-8 and skip binary files (null-byte heuristic)
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes("\0")) continue;
        result[relPath] = content;
        totalBytes += stat.size;
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(wsDir);
  return result;
}

/**
 * Replaces a string value with a presence flag: "(set)" if truthy, "(empty)" otherwise.
 */
function redactStringValue(val: unknown): string {
  return val ? "(set)" : "(empty)";
}

/**
 * Reads the workspace config.json and strips sensitive fields.
 * Returns undefined if the file is missing or unreadable.
 */
function readSanitizedConfig(): Record<string, unknown> | undefined {
  const configPath = getWorkspaceConfigPath();
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    // Strip ingress webhook secret
    if (config.ingress && typeof config.ingress === "object") {
      const ingress = config.ingress as Record<string, unknown>;
      if (ingress.webhook && typeof ingress.webhook === "object") {
        const webhook = ingress.webhook as Record<string, unknown>;
        webhook.secret = redactStringValue(webhook.secret);
        ingress.webhook = webhook;
      }
      config.ingress = ingress;
    }

    // Strip skill-level API keys and env vars
    if (config.skills && typeof config.skills === "object") {
      const skills = config.skills as Record<string, unknown>;
      if (skills.entries && typeof skills.entries === "object") {
        const entries = skills.entries as Record<string, unknown>;
        for (const name of Object.keys(entries)) {
          const entry = entries[name];
          if (entry && typeof entry === "object") {
            const e = entry as Record<string, unknown>;
            if ("apiKey" in e) e.apiKey = redactStringValue(e.apiKey);
            if (e.env && typeof e.env === "object") {
              const env = e.env as Record<string, unknown>;
              e.env = Object.fromEntries(
                Object.keys(env).map((k) => [k, redactStringValue(env[k])]),
              );
            }
          }
        }
      }
    }

    // Strip Twilio accountSid
    if (config.twilio && typeof config.twilio === "object") {
      const twilio = config.twilio as Record<string, unknown>;
      twilio.accountSid = redactStringValue(twilio.accountSid);
      config.twilio = twilio;
    }

    // Strip MCP transport headers (SSE/streamable-http) and env vars (stdio)
    if (config.mcp && typeof config.mcp === "object") {
      const mcp = config.mcp as Record<string, unknown>;
      if (mcp.servers && typeof mcp.servers === "object") {
        const servers = mcp.servers as Record<string, unknown>;
        for (const name of Object.keys(servers)) {
          const server = servers[name];
          if (server && typeof server === "object") {
            const s = server as Record<string, unknown>;
            if (s.transport && typeof s.transport === "object") {
              const transport = s.transport as Record<string, unknown>;
              if (transport.headers && typeof transport.headers === "object") {
                const headers = transport.headers as Record<string, unknown>;
                transport.headers = Object.fromEntries(
                  Object.keys(headers).map((k) => [
                    k,
                    redactStringValue(headers[k]),
                  ]),
                );
              }
              if (transport.env && typeof transport.env === "object") {
                const env = transport.env as Record<string, unknown>;
                transport.env = Object.fromEntries(
                  Object.keys(env).map((k) => [k, redactStringValue(env[k])]),
                );
              }
            }
          }
        }
      }
    }

    return config;
  } catch {
    return undefined;
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
