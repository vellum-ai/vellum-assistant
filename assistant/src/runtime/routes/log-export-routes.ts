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

import { getDb } from "../../memory/db-connection.js";
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
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { createTarGz } from "./archive-utils.js";
import { InternalError } from "./errors.js";
import { collectWorkspaceData } from "./log-export/workspace-allowlist.js";
import { redactStagedExportFiles } from "./redact-staged-export.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("log-export-routes");

/** Maximum total payload size for log file contents (10 MB). */
const MAX_LOG_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Row caps for the conversation-data table dumps (`messages.json`,
 * `llm-request-logs.json`, `llm-usage-events.json`). Without them, a
 * `full: true` export dumps entire tables — for long-tenured users the only
 * realistic way to blow past the sweep's `MAX_SWEEP_FILE_BYTES` cap, which
 * fails closed by replacing the whole file with an omission note. Bounding
 * at the source keeps the most recent (and most useful) rows instead,
 * mirroring the `auditLimit` pattern: order by createdAt desc, newest rows
 * first. Truncated sections are logged and surfaced in both the export log
 * line and `export-manifest.json` (`truncatedSections`), so a capped bundle
 * is distinguishable from a complete one.
 */
const MAX_EXPORT_MESSAGE_ROWS = 10_000;
export const MAX_EXPORT_LLM_REQUEST_LOG_ROWS = 2_000;
const MAX_EXPORT_LLM_USAGE_EVENT_ROWS = 10_000;

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
    // Sections truncated by a row cap, surfaced in the export log line and
    // the export manifest.
    const truncatedSections: string[] = [];
    /**
     * Keep the newest `limit` rows of a section dump. Callers fetch
     * `limit + 1` rows so truncation is detectable without a COUNT query.
     */
    const capRows = <T>(rows: T[], limit: number, section: string): T[] => {
      if (rows.length <= limit) return rows;
      truncatedSections.push(section);
      log.warn(
        { section, limit },
        "Export section exceeded its row cap; keeping only the most recent rows",
      );
      return rows.slice(0, limit);
    };
    if (conversationId || full) {
      const conversationFilter = conversationId
        ? [eq(messages.conversationId, conversationId)]
        : [];

      const messageRows = capRows(
        db
          .select()
          .from(messages)
          .where(
            and(
              ...conversationFilter,
              startTime ? gte(messages.createdAt, startTime) : undefined,
              endTime ? lte(messages.createdAt, endTime) : undefined,
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(MAX_EXPORT_MESSAGE_ROWS + 1)
          .all(),
        MAX_EXPORT_MESSAGE_ROWS,
        "messages",
      );
      writeFileSync(
        join(staging, "messages.json"),
        JSON.stringify(messageRows, null, 2),
        "utf-8",
      );

      const llmConversationFilter = conversationId
        ? [eq(llmRequestLogs.conversationId, conversationId)]
        : [];

      const llmLogRows = capRows(
        db
          .select()
          .from(llmRequestLogs)
          .where(
            and(
              ...llmConversationFilter,
              startTime ? gte(llmRequestLogs.createdAt, startTime) : undefined,
              endTime ? lte(llmRequestLogs.createdAt, endTime) : undefined,
            ),
          )
          .orderBy(desc(llmRequestLogs.createdAt))
          .limit(MAX_EXPORT_LLM_REQUEST_LOG_ROWS + 1)
          .all(),
        MAX_EXPORT_LLM_REQUEST_LOG_ROWS,
        "llm-request-logs",
      );
      writeFileSync(
        join(staging, "llm-request-logs.json"),
        JSON.stringify(llmLogRows, null, 2),
        "utf-8",
      );

      const usageConversationFilter = conversationId
        ? [eq(llmUsageEvents.conversationId, conversationId)]
        : [];

      const usageRows = capRows(
        db
          .select()
          .from(llmUsageEvents)
          .where(
            and(
              ...usageConversationFilter,
              startTime ? gte(llmUsageEvents.createdAt, startTime) : undefined,
              endTime ? lte(llmUsageEvents.createdAt, endTime) : undefined,
            ),
          )
          .orderBy(desc(llmUsageEvents.createdAt))
          .limit(MAX_EXPORT_LLM_USAGE_EVENT_ROWS + 1)
          .all(),
        MAX_EXPORT_LLM_USAGE_EVENT_ROWS,
        "llm-usage-events",
      );
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

    // --- Conversation-scoped daemon log slice ---
    // Write a `conversation-filtered.jsonl` slice of the lines that mention the
    // conversationId as a quick index into the full daily logs.
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

      // We intentionally retain the full daily `assistant-*.log` and
      // `daemon-stderr.log` files rather than removing them here. Agent-loop
      // failures — stream aborts, stack traces, provider errors — are routinely
      // logged without the conversationId, so the grep above drops exactly the
      // lines needed to debug a failed turn. We cannot currently guarantee that
      // every log line emitted while handling a conversation carries its
      // conversationId; until we can, the full daily log must stay in the
      // bundle. Re-enable the removal below only once that guarantee holds.
      //
      // for (const logFile of collectedLogFiles) {
      //   try {
      //     rmSync(logFile, { force: true });
      //   } catch {
      //     // Best-effort removal
      //   }
      // }
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

    // --- Connected clients (`assistant clients list --json`) ---
    try {
      const clients = assistantEventHub.listClients();
      const clientsList = {
        clients: clients.map((c) => ({
          clientId: c.clientId,
          interfaceId: c.interfaceId,
          capabilities: c.capabilities,
          machineName: c.machineName,
          connectedAt: c.connectedAt.toISOString(),
          lastActiveAt: c.lastActiveAt.toISOString(),
        })),
      };
      writeFileSync(
        join(staging, "clients-list.json"),
        JSON.stringify(clientsList, null, 2),
        "utf-8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFileSync(
        join(staging, "clients-list-error.json"),
        JSON.stringify(
          {
            error: message,
            collectedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
      log.warn(
        { err },
        "Failed to collect connected clients list, continuing without it",
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
      ...(truncatedSections.length > 0 ? { truncatedSections } : {}),
      exportedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(staging, "export-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // --- Secret-redaction sweep over every staged text file ---
    // Belt-and-suspenders over the structural sanitizers above: catches
    // legacy audit rows persisted with plaintext inputs (written before
    // write-time redaction existed) and secrets sitting in copied workspace
    // conversation files.
    const redactionResult = redactStagedExportFiles(staging);

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
        truncatedSections,
        redactionScanned: redactionResult.filesScanned,
        redactionRedacted: redactionResult.filesRedacted,
        redactionOmitted: redactionResult.filesOmitted,
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

/**
 * Narrow an unknown value to a mutable record, or undefined if not an object.
 * Deliberately looser than `isPlainObject` (`util/object.ts`): arrays are
 * admitted on purpose so sanitization stays fail-closed — a malformed config
 * shape must redact more, never less.
 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Replace every value in a map with its (set)/(empty) presence flag. */
function redactValueMap(obj: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(obj).map((k) => [k, redactStringValue(obj[k])]),
  );
}

function readSanitizedConfig(): Record<string, unknown> | undefined {
  const configPath = getWorkspaceConfigPath();
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    delete config.apiKeys;

    const webhook = asRecord(asRecord(config.ingress)?.webhook);
    if (webhook) webhook.secret = redactStringValue(webhook.secret);

    const skillEntries = asRecord(asRecord(config.skills)?.entries);
    for (const entry of Object.values(skillEntries ?? {})) {
      const e = asRecord(entry);
      if (!e) continue;
      if ("apiKey" in e) e.apiKey = redactStringValue(e.apiKey);
      const env = asRecord(e.env);
      if (env) e.env = redactValueMap(env);
    }

    const twilio = asRecord(config.twilio);
    if (twilio) twilio.accountSid = redactStringValue(twilio.accountSid);

    const acpAgents = asRecord(asRecord(config.acp)?.agents);
    for (const agent of Object.values(acpAgents ?? {})) {
      const a = asRecord(agent);
      if (!a) continue;
      // Agent env is an arbitrary user-supplied map (often API keys);
      // redact every value and keep only the key names.
      const env = asRecord(a.env);
      if (env) a.env = redactValueMap(env);
    }

    const mcpServers = asRecord(asRecord(config.mcp)?.servers);
    for (const server of Object.values(mcpServers ?? {})) {
      const transport = asRecord(asRecord(server)?.transport);
      if (!transport) continue;
      const headers = asRecord(transport.headers);
      if (headers) transport.headers = redactValueMap(headers);
      const env = asRecord(transport.env);
      if (env) transport.env = redactValueMap(env);
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleExport,
    summary: "Export logs and audit data",
    description:
      "Export audit records, assistant logs, and config as a tar.gz archive.",
    tags: ["export"],
    requestBody: exportRequestBody,
    responseBody: {
      contentType: "application/gzip",
      schema: { type: "string", format: "binary" },
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleExport,
    summary: "Export logs and audit data (alias)",
    description:
      "Alias for /v1/export. Export audit records, assistant logs, and config as a tar.gz archive.",
    tags: ["export"],
    requestBody: exportRequestBody,
    responseBody: {
      contentType: "application/gzip",
      schema: { type: "string", format: "binary" },
    },
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
