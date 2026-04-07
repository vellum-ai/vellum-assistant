/**
 * HTTP route handler for exporting audit data and daemon log files.
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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { createTarGz } from "./archive-utils.js";
import { collectWorkspaceData } from "./log-export/workspace-allowlist.js";

const log = getLogger("log-export-routes");

/** Maximum total payload size for log file contents (10 MB). */
const MAX_LOG_PAYLOAD_BYTES = 10 * 1024 * 1024;

interface ExportRequestBody {
  auditLimit?: number;
  conversationId?: string; // scope to a single conversation
  startTime?: number; // epoch ms — lower bound (inclusive)
  endTime?: number; // epoch ms — upper bound (inclusive)
}

/**
 * Collect audit data, daemon log files, and a sanitized config snapshot,
 * then package everything into a tar.gz archive.
 *
 * Archive layout:
 *   audit-data.json                 — tool invocation records
 *   config-snapshot.json            — sanitized workspace config
 *   daemon-logs/<name>              — daemon log files
 *   workspace/conversations/<dir>/  — allowlisted workspace data (see ./log-export/AGENTS.md)
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
    const startDate = startTime ? new Date(startTime) : undefined;
    const endDate = endTime ? new Date(endTime) : undefined;
    if (existsSync(logsDir)) {
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        // Filter dated log files by time range
        const dateMatch = entry.match(LOG_FILE_PATTERN);
        if (dateMatch && (startDate || endDate)) {
          const fileDate = new Date(dateMatch[1] + "T23:59:59.999Z"); // end of day
          const fileDateStart = new Date(dateMatch[1] + "T00:00:00.000Z");
          if (startDate && fileDate < startDate) continue; // entire day is before range
          if (endDate && fileDateStart > endDate) continue; // entire day is after range
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

    // --- Workspace allowlist ---
    // Includes specific subpaths from <workspace>/ governed by the rules in
    // ./log-export/AGENTS.md. Honors the same time + conversation filters as
    // the rest of the export.
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
    const manifest = conversationId
      ? {
          type: "conversation-export" as const,
          conversationId,
          assistantVersion: APP_VERSION,
          commitSha: COMMIT_SHA,
          ...(startTime !== undefined ? { startTime } : {}),
          ...(endTime !== undefined ? { endTime } : {}),
          exportedAt: new Date().toISOString(),
        }
      : {
          type: "global-export" as const,
          assistantVersion: APP_VERSION,
          commitSha: COMMIT_SHA,
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
        workspaceEntries: workspaceResult.entries.length,
        workspaceBytes: workspaceResult.totalBytes,
      },
      "Export collected, creating tar.gz archive",
    );

    // --- Create tar.gz archive ---
    const archiveBytes = createTarGz(staging);
    if (!archiveBytes) {
      return httpError("INTERNAL_ERROR", "Failed to create archive", 500);
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
    startTime: z.number().optional().describe("Lower bound epoch ms"),
    endTime: z.number().optional().describe("Upper bound epoch ms"),
  });

  return [
    {
      endpoint: "export",
      method: "POST",
      policyKey: "export",
      summary: "Export logs and audit data",
      description:
        "Export audit records, assistant logs, and config as a tar.gz archive.",
      tags: ["export"],
      requestBody: exportRequestBody,
      handler: async ({ req }) => {
        const body = (await req.json()) as ExportRequestBody;
        return handleExport(body);
      },
    },
    {
      endpoint: "logs/export",
      method: "POST",
      policyKey: "export",
      summary: "Export logs and audit data (alias)",
      description:
        "Alias for /v1/export. Export audit records, assistant logs, and config as a tar.gz archive.",
      tags: ["export"],
      requestBody: exportRequestBody,
      handler: async ({ req }) => {
        const body = (await req.json()) as ExportRequestBody;
        return handleExport(body);
      },
    },
  ];
}
