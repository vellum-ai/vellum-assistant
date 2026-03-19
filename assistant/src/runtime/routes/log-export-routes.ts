/**
 * HTTP route handler for exporting audit data and daemon log files.
 *
 * A single POST /v1/export endpoint allows clients (e.g. macOS Export Logs)
 * to retrieve audit database records, daemon log files, workspace contents,
 * and a sanitized config snapshot as a tar.gz archive.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { and, desc, eq, gte, lte } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import {
  llmRequestLogs,
  llmUsageEvents,
  messages,
  toolInvocations,
} from "../../memory/schema.js";
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

/** Maximum compressed archive size before pruning workspace directories (50 MB). */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

interface ExportRequestBody {
  auditLimit?: number;
  conversationId?: string; // scope to a single conversation
  startTime?: number; // epoch ms — lower bound (inclusive)
  endTime?: number; // epoch ms — upper bound (inclusive)
}

/**
 * Collect audit data, daemon log files, workspace contents, and a sanitized
 * config snapshot, then package everything into a tar.gz archive.
 *
 * Archive layout:
 *   audit-data.json          — tool invocation records
 *   config-snapshot.json     — sanitized workspace config
 *   daemon-logs/<name>       — daemon log files
 *   workspace/<relpath>      — workspace file tree
 */
async function handleExport(body: ExportRequestBody): Promise<Response> {
  const staging = mkdtempSync(join(tmpdir(), "vellum-export-"));

  try {
    const { conversationId, startTime, endTime } = body;

    // --- Audit data ---
    const limit = body.auditLimit ?? 1000;
    const db = getDb();

    const auditQuery = db.select().from(toolInvocations);

    const timeFilters = [
      ...(conversationId
        ? [eq(toolInvocations.conversationId, conversationId)]
        : []),
      ...(startTime ? [gte(toolInvocations.createdAt, startTime)] : []),
      ...(endTime ? [lte(toolInvocations.createdAt, endTime)] : []),
    ];

    const auditRows = (
      timeFilters.length > 0
        ? auditQuery.where(and(...timeFilters))
        : auditQuery
    )
      .orderBy(desc(toolInvocations.createdAt))
      .limit(limit)
      .all();

    writeFileSync(
      join(staging, "audit-data.json"),
      JSON.stringify(auditRows, null, 2),
      "utf-8",
    );

    // --- Conversation-scoped data tables ---
    if (conversationId) {
      const messageRows = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            startTime ? gte(messages.createdAt, startTime) : undefined,
            endTime ? lte(messages.createdAt, endTime) : undefined,
          ),
        )
        .orderBy(messages.createdAt)
        .all();
      writeFileSync(
        join(staging, "messages.json"),
        JSON.stringify(messageRows, null, 2),
        "utf-8",
      );

      const llmLogRows = db
        .select()
        .from(llmRequestLogs)
        .where(
          and(
            eq(llmRequestLogs.conversationId, conversationId),
            startTime ? gte(llmRequestLogs.createdAt, startTime) : undefined,
            endTime ? lte(llmRequestLogs.createdAt, endTime) : undefined,
          ),
        )
        .orderBy(llmRequestLogs.createdAt)
        .all();
      writeFileSync(
        join(staging, "llm-request-logs.json"),
        JSON.stringify(llmLogRows, null, 2),
        "utf-8",
      );

      const usageRows = db
        .select()
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.conversationId, conversationId),
            startTime ? gte(llmUsageEvents.createdAt, startTime) : undefined,
            endTime ? lte(llmUsageEvents.createdAt, endTime) : undefined,
          ),
        )
        .orderBy(llmUsageEvents.createdAt)
        .all();
      writeFileSync(
        join(staging, "llm-usage-events.json"),
        JSON.stringify(usageRows, null, 2),
        "utf-8",
      );
    }

    // --- Daemon log files ---
    const daemonLogsDir = join(staging, "daemon-logs");
    mkdirSync(daemonLogsDir, { recursive: true });
    let totalBytes = 0;
    let logFileCount = 0;

    const logsDir = join(getDataDir(), "logs");
    const collectedLogFiles: string[] = [];
    if (existsSync(logsDir)) {
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        const filePath = join(logsDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;
          if (totalBytes + stat.size > MAX_LOG_PAYLOAD_BYTES) continue;
          const content = readFileSync(filePath, "utf-8");
          writeFileSync(join(daemonLogsDir, entry), content, "utf-8");
          collectedLogFiles.push(join(daemonLogsDir, entry));
          totalBytes += stat.size;
          logFileCount++;
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
          const content = readFileSync(stderrPath, "utf-8");
          const dest = join(daemonLogsDir, "daemon-stderr.log");
          writeFileSync(dest, content, "utf-8");
          collectedLogFiles.push(dest);
          logFileCount++;
        }
      } catch {
        // Skip if unreadable
      }
    }

    // --- Daemon log grep for conversationId ---
    if (conversationId && collectedLogFiles.length > 0) {
      const matchingLines: string[] = [];
      for (const logFile of collectedLogFiles) {
        try {
          const content = readFileSync(logFile, "utf-8");
          for (const line of content.split("\n")) {
            if (line.includes(conversationId)) {
              matchingLines.push(line);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
      if (matchingLines.length > 0) {
        writeFileSync(
          join(daemonLogsDir, "conversation-filtered.jsonl"),
          matchingLines.join("\n") + "\n",
          "utf-8",
        );
      }

      // Remove full unfiltered log files — conversation-scoped exports
      // should only include conversation-filtered.jsonl to avoid leaking
      // data from unrelated conversations.
      for (const logFile of collectedLogFiles) {
        try {
          rmSync(logFile, { force: true });
        } catch {
          // Best-effort removal
        }
      }
    }

    // --- Sanitized config snapshot ---
    const configSnapshot = readSanitizedConfig();
    if (configSnapshot) {
      writeFileSync(
        join(staging, "config-snapshot.json"),
        JSON.stringify(configSnapshot, null, 2),
        "utf-8",
      );
    }

    // --- Workspace files (skip for conversation-scoped exports) ---
    let workspaceFileCount = 0;
    if (!conversationId) {
      const workspaceFiles = collectWorkspaceFiles();
      const workspaceDir = join(staging, "workspace");
      mkdirSync(workspaceDir, { recursive: true });
      for (const [relPath, content] of Object.entries(workspaceFiles)) {
        const dest = join(workspaceDir, relPath);
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, content, "utf-8");
      }
      workspaceFileCount = Object.keys(workspaceFiles).length;
    }

    // --- Export manifest ---
    const manifest = conversationId
      ? {
          type: "conversation-export" as const,
          conversationId,
          ...(startTime !== undefined ? { startTime } : {}),
          ...(endTime !== undefined ? { endTime } : {}),
          exportedAt: new Date().toISOString(),
        }
      : {
          type: "global-export" as const,
          exportedAt: new Date().toISOString(),
        };
    writeFileSync(
      join(staging, "export-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    log.info(
      {
        auditCount: auditRows.length,
        logFileCount,
        totalBytes,
        hasConfig: configSnapshot !== undefined,
        workspaceFileCount,
        conversationId: conversationId ?? null,
      },
      "Export collected, creating tar.gz archive",
    );

    // --- Create tar.gz archive, pruning workspace dirs if too large ---
    const excludedDirs: string[] = [];
    let archiveBytes = createTarGz(staging);

    while (!archiveBytes) {
      // Conversation-scoped exports have no workspace directory to prune —
      // if the archive still exceeds the size limit, report a clear error.
      if (conversationId) {
        log.error(
          "Conversation-scoped export exceeds archive size limit with no workspace dirs to prune",
        );
        return httpError(
          "INTERNAL_ERROR",
          "Conversation export exceeds the maximum archive size",
          500,
        );
      }

      // Find the largest top-level directory under workspace/ and remove it
      const wsDir = join(staging, "workspace");
      const largest = findLargestSubdirectory(wsDir);
      if (!largest) {
        log.error("tar command failed and no workspace dirs to prune");
        return httpError("INTERNAL_ERROR", "Failed to create archive", 500);
      }

      log.warn(
        { dir: largest.name, bytes: largest.bytes },
        "Archive exceeds size limit, removing largest workspace directory",
      );
      excludedDirs.push(
        `workspace/${largest.name} (${formatBytes(largest.bytes)})`,
      );
      rmSync(join(wsDir, largest.name), { recursive: true, force: true });
      archiveBytes = createTarGz(staging);
    }

    if (excludedDirs.length > 0) {
      const errorLines = [
        "The following workspace directories were excluded because the archive exceeded the size limit:",
        "",
        ...excludedDirs.map((d) => `  - ${d}`),
        "",
        "Use the streaming export endpoint for full workspace exports.",
      ];
      writeFileSync(join(staging, "error.log"), errorLines.join("\n"), "utf-8");

      // Re-create the archive now that error.log is included
      const withErrorLog = createTarGz(staging);
      if (withErrorLog) {
        archiveBytes = withErrorLog;
      }
    }

    return new Response(archiveBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="logs.tar.gz"',
        "Content-Length": String(archiveBytes.byteLength),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export");
    return httpError("INTERNAL_ERROR", `Failed to export: ${message}`, 500);
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Attempts to create a tar.gz archive of `staging` into a Buffer.
 * Returns the Buffer on success, or `undefined` if the archive exceeds
 * the size limit or tar otherwise fails.
 */
function createTarGz(staging: string): ArrayBuffer | undefined {
  const proc = spawnSync("tar", ["czf", "-", "-C", staging, "."], {
    maxBuffer: MAX_ARCHIVE_BYTES,
    timeout: 30_000,
  });
  if (proc.status !== 0) return undefined;
  const buf = Buffer.isBuffer(proc.stdout)
    ? proc.stdout
    : Buffer.from(proc.stdout);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Returns the name and total byte size of the largest top-level subdirectory
 * inside `dir`, or `undefined` if `dir` has no subdirectories.
 */
function findLargestSubdirectory(
  dir: string,
): { name: string; bytes: number } | undefined {
  if (!existsSync(dir)) return undefined;

  let largest: { name: string; bytes: number } | undefined;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const bytes = directorySize(fullPath);
    if (!largest || bytes > largest.bytes) {
      largest = { name: entry, bytes };
    }
  }

  return largest;
}

/** Recursively sums the byte size of all files in `dir`. */
function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          total += directorySize(fullPath);
        } else if (stat.isFile()) {
          total += stat.size;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return total;
}

/** Formats a byte count as a human-readable string (e.g. "12.3 MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Directory prefixes to skip when collecting workspace files. */
const WORKSPACE_SKIP_DIRS = new Set([
  "embedding-models",
  "data/qdrant",
  "data/attachments",
  "conversations",
]);

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

        // SQLite DB handling: dump as SQL text, then enforce size cap
        if (entry.endsWith(".db")) {
          // Skip the dump entirely if the budget is already exhausted
          if (totalBytes >= MAX_WORKSPACE_PAYLOAD_BYTES) continue;
          try {
            const proc = spawnSync("sqlite3", [fullPath, ".dump"], {
              timeout: 10_000,
            });
            if (proc.status === 0 && proc.stdout) {
              const output =
                proc.stdout instanceof Buffer
                  ? proc.stdout.toString("utf-8")
                  : String(proc.stdout);
              const outputBytes = Buffer.byteLength(output, "utf-8");
              if (totalBytes + outputBytes > MAX_WORKSPACE_PAYLOAD_BYTES)
                continue;
              result[relPath + ".sql"] = output;
              totalBytes += outputBytes;
            }
          } catch {
            // Skip if dump fails
          }
          continue;
        }

        // Enforce cumulative size cap for non-DB files
        if (totalBytes + stat.size > MAX_WORKSPACE_PAYLOAD_BYTES) continue;

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

    // Strip legacy apiKeys (removed from schema but may still exist in old config files)
    delete config.apiKeys;

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
