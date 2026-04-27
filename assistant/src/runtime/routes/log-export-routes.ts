/**
 * Route handler for exporting audit data and daemon log files.
 *
 * A single POST /v1/export endpoint allows clients (e.g. macOS Export Logs)
 * to retrieve audit database records, daemon log files, and a sanitized
 * config snapshot as a tar.gz archive.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db.js";
import {
  llmRequestLogs,
  llmUsageEvents,
  messages,
  toolInvocations,
} from "../../memory/schema.js";
import { getLogger, LOG_FILE_PATTERN } from "../../util/logger.js";
import {
  getDaemonStderrLogPath,
  getDataDir,
  getWorkspaceConfigPath,
} from "../../util/platform.js";
import { APP_VERSION, COMMIT_SHA } from "../../version.js";
import { createTarGz } from "./archive-utils.js";
import { InternalError } from "./errors.js";
import { collectWorkspaceData } from "./log-export/workspace-allowlist.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("log-export-routes");

/** Maximum total payload size for log file contents (10 MB). */
const MAX_LOG_PAYLOAD_BYTES = 10 * 1024 * 1024;

interface ExportRequestBody {
  auditLimit?: number;
  conversationId?: string;
  full?: boolean;
  startTime?: number;
  endTime?: number;
}

/**
 * Collect audit data, daemon log files, and a sanitized config snapshot,
 * then package everything into a tar.gz archive.
 *
 * Returns the archive as a Uint8Array — the HTTP adapter handles binary
 * responses natively.
 */
async function handleExport({
  body = {},
}: RouteHandlerArgs): Promise<Uint8Array> {
  const { conversationId, full, startTime, endTime, auditLimit } =
    body as ExportRequestBody;

  const staging = mkdtempSync(join(tmpdir(), "vellum-export-"));

  try {
    // --- Audit data ---
    const limit = auditLimit ?? 1000;
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

    // --- Conversation data tables ---
    if (conversationId || full) {
      const conversationFilter = conversationId
        ? [eq(messages.conversationId, conversationId)]
        : [];

      const messageRows = db
        .select()
        .from(messages)
        .where(
          and(
            ...conversationFilter,
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

      const llmConversationFilter = conversationId
        ? [eq(llmRequestLogs.conversationId, conversationId)]
        : [];

      const llmLogRows = db
        .select()
        .from(llmRequestLogs)
        .where(
          and(
            ...llmConversationFilter,
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

      const usageConversationFilter = conversationId
        ? [eq(llmUsageEvents.conversationId, conversationId)]
        : [];

      const usageRows = db
        .select()
        .from(llmUsageEvents)
        .where(
          and(
            ...usageConversationFilter,
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
    const startDate = startTime ? new Date(startTime) : undefined;
    const endDate = endTime ? new Date(endTime) : undefined;
    if (existsSync(logsDir)) {
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        const dateMatch = entry.match(LOG_FILE_PATTERN);
        if (dateMatch && (startDate || endDate)) {
          const fileDate = new Date(dateMatch[1] + "T23:59:59.999Z");
          const fileDateStart = new Date(dateMatch[1] + "T00:00:00.000Z");
          if (startDate && fileDate < startDate) continue;
          if (endDate && fileDateStart > endDate) continue;
        }
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

    const stderrPath = getDaemonStderrLogPath();
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

      for (const logFile of collectedLogFiles) {
        try {
          rmSync(logFile, { force: true });
        } catch {
          // Best-effort removal
        }
      }
    }

    // --- Workspace allowlist ---
    const workspaceResult = collectWorkspaceData({
      staging,
      conversationId: conversationId || undefined,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
    });

    // --- Sanitized config snapshot ---
    const configSnapshot = readSanitizedConfig();
    if (configSnapshot) {
      writeFileSync(
        join(staging, "config-snapshot.json"),
        JSON.stringify(configSnapshot, null, 2),
        "utf-8",
      );
    }

    // --- Export manifest ---
    const manifestType = conversationId
      ? ("conversation-export" as const)
      : full
        ? ("full-export" as const)
        : ("global-export" as const);
    const manifest = {
      type: manifestType,
      ...(conversationId ? { conversationId } : {}),
      ...(full ? { full: true } : {}),
      assistantVersion: APP_VERSION,
      commitSha: COMMIT_SHA,
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
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
        conversationId: conversationId ?? null,
        full: full ?? false,
        workspaceEntries: workspaceResult.entries.length,
        workspaceBytes: workspaceResult.totalBytes,
      },
      "Export collected, creating tar.gz archive",
    );

    // --- Create tar.gz archive ---
    const archiveBuffer = createTarGz(staging);
    if (!archiveBuffer) {
      throw new InternalError("Failed to create archive");
    }

    return new Uint8Array(archiveBuffer);
  } catch (err) {
    if (err instanceof InternalError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to export");
    throw new InternalError(`Failed to export: ${message}`);
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Config sanitization helpers
// ---------------------------------------------------------------------------

function redactStringValue(val: unknown): string {
  return val ? "(set)" : "(empty)";
}

function readSanitizedConfig(): Record<string, unknown> | undefined {
  const configPath = getWorkspaceConfigPath();
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    delete config.apiKeys;

    if (config.ingress && typeof config.ingress === "object") {
      const ingress = config.ingress as Record<string, unknown>;
      if (ingress.webhook && typeof ingress.webhook === "object") {
        const webhook = ingress.webhook as Record<string, unknown>;
        webhook.secret = redactStringValue(webhook.secret);
        ingress.webhook = webhook;
      }
      config.ingress = ingress;
    }

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

    if (config.twilio && typeof config.twilio === "object") {
      const twilio = config.twilio as Record<string, unknown>;
      twilio.accountSid = redactStringValue(twilio.accountSid);
      config.twilio = twilio;
    }

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

const exportRequestBody = z.object({
  auditLimit: z
    .number()
    .int()
    .optional()
    .describe("Max audit records (default 1000)"),
  conversationId: z
    .string()
    .optional()
    .describe("Scope to a single conversation"),
  full: z
    .boolean()
    .optional()
    .describe(
      "Full export — include messages, LLM request logs, and usage events for all conversations.",
    ),
  startTime: z.number().optional().describe("Lower bound epoch ms"),
  endTime: z.number().optional().describe("Upper bound epoch ms"),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "export_logs",
    endpoint: "export",
    method: "POST",
    policyKey: "export",
    handler: handleExport,
    summary: "Export logs and audit data",
    description:
      "Export audit records, assistant logs, and config as a tar.gz archive.",
    tags: ["export"],
    requestBody: exportRequestBody,
    responseHeaders: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="logs.tar.gz"',
    },
    additionalResponses: {
      "500": {
        description: "Failed to create archive",
      },
    },
  },
  {
    operationId: "export_logs_alias",
    endpoint: "logs/export",
    method: "POST",
    policyKey: "export",
    handler: handleExport,
    summary: "Export logs and audit data (alias)",
    description:
      "Alias for /v1/export. Export audit records, assistant logs, and config as a tar.gz archive.",
    tags: ["export"],
    requestBody: exportRequestBody,
    responseHeaders: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="logs.tar.gz"',
    },
    additionalResponses: {
      "500": {
        description: "Failed to create archive",
      },
    },
  },
];
