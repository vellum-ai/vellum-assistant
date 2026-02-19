import * as net from 'node:net';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import archiver from 'archiver';
import { getDb } from '../../memory/db.js';
import { messages, toolInvocations, llmUsageEvents, llmRequestLogs } from '../../memory/schema.js';
import type { DiagnosticsExportRequest } from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

const MAX_CONTENT_LENGTH = 500;

/**
 * Regex patterns for redacting potentially sensitive data.
 * Matches common API key formats, email addresses, and bearer tokens.
 */
const REDACT_PATTERNS = [
  // API keys: sk-..., key-..., api_key_..., etc.
  /\b(sk|key|api[_-]?key|token|secret|password|passwd|credential)[_\-]?[a-zA-Z0-9]{16,}\b/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
  // Email addresses
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  // AWS-style keys
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Generic hex/base64 secrets (32+ chars)
  /\b[A-Fa-f0-9]{32,}\b/g,
];

function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function truncateAndRedact(text: string): string {
  const truncated = text.length > MAX_CONTENT_LENGTH
    ? text.slice(0, MAX_CONTENT_LENGTH) + '...[truncated]'
    : text;
  return redact(truncated);
}

/** Keys whose values should always be fully redacted in LLM request/response payloads. */
const SENSITIVE_KEYS = new Set([
  'api_key', 'apikey', 'api-key',
  'authorization', 'x-api-key',
  'secret', 'password', 'token',
  'credential', 'credentials',
]);

/**
 * Recursively walk a parsed JSON value and apply redaction to all string
 * leaves. Object keys matching known sensitive field names have their
 * entire value replaced with '[REDACTED]'.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

export async function handleDiagnosticsExport(
  msg: DiagnosticsExportRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const db = getDb();
    const { conversationId } = msg;

    // 1. Find the anchor message
    let anchorMessage;
    if (msg.anchorMessageId) {
      anchorMessage = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, msg.anchorMessageId),
            eq(messages.conversationId, conversationId),
          ),
        )
        .get();
    } else {
      // Find the latest assistant message in the conversation
      anchorMessage = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.role, 'assistant'),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .get();
    }

    if (!anchorMessage) {
      ctx.send(socket, {
        type: 'diagnostics_export_response',
        success: false,
        error: 'Anchor message not found',
      });
      return;
    }

    // 2. Find the preceding user message
    const precedingUserMessage = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'user'),
          lte(messages.createdAt, anchorMessage.createdAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get();

    // Use the preceding user message timestamp as the range start,
    // or fall back to the anchor message timestamp minus a small buffer.
    // Request logs are recorded during the usage event before the assistant
    // message is persisted, so same-turn logs can have timestamps slightly
    // earlier than the anchor.
    const rangeStart = precedingUserMessage?.createdAt ?? (anchorMessage.createdAt - 2000);
    const rangeEnd = anchorMessage.createdAt;
    // Usage events are recorded asynchronously after the assistant message
    // is persisted, so their createdAt can be slightly later. Use a separate
    // extended bound for the usage query only to avoid pulling in unrelated
    // messages or tool invocations from the next turn.
    const usageRangeEnd = anchorMessage.createdAt + 5000;

    // 3. Query all messages in the range
    const rangeMessages = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gte(messages.createdAt, rangeStart),
          lte(messages.createdAt, rangeEnd),
        ),
      )
      .orderBy(messages.createdAt)
      .all();

    // 4. Query tool invocations in the range
    const rangeToolInvocations = db
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.conversationId, conversationId),
          gte(toolInvocations.createdAt, rangeStart),
          lte(toolInvocations.createdAt, rangeEnd),
        ),
      )
      .orderBy(toolInvocations.createdAt)
      .all();

    // 5. Query LLM usage events in the range
    const rangeUsageEvents = db
      .select()
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.conversationId, conversationId),
          gte(llmUsageEvents.createdAt, rangeStart),
          lte(llmUsageEvents.createdAt, usageRangeEnd),
        ),
      )
      .orderBy(llmUsageEvents.createdAt)
      .all();

    // 5b. Query raw LLM request/response logs in the range
    const rangeRequestLogs = db
      .select()
      .from(llmRequestLogs)
      .where(
        and(
          eq(llmRequestLogs.conversationId, conversationId),
          gte(llmRequestLogs.createdAt, rangeStart),
          lte(llmRequestLogs.createdAt, usageRangeEnd),
        ),
      )
      .orderBy(llmRequestLogs.createdAt)
      .all();

    // 6. Write export files to a temp directory
    const exportId = `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const tempDir = join(tmpdir(), exportId);
    mkdirSync(tempDir, { recursive: true });

    try {
      // manifest.json
      const manifest = {
        version: '1.1',
        exportedAt: new Date().toISOString(),
        conversationId,
        messageId: anchorMessage.id,
      };
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // messages.jsonl
      const messagesLines = rangeMessages.map((m) =>
        JSON.stringify({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: truncateAndRedact(m.content),
          createdAt: m.createdAt,
        }),
      );
      writeFileSync(join(tempDir, 'messages.jsonl'), messagesLines.join('\n') + (messagesLines.length > 0 ? '\n' : ''));

      // tool_invocations.jsonl
      const toolLines = rangeToolInvocations.map((t) =>
        JSON.stringify({
          id: t.id,
          conversationId: t.conversationId,
          toolName: t.toolName,
          input: truncateAndRedact(t.input),
          result: truncateAndRedact(t.result),
          decision: t.decision,
          riskLevel: t.riskLevel,
          durationMs: t.durationMs,
          createdAt: t.createdAt,
        }),
      );
      writeFileSync(join(tempDir, 'tool_invocations.jsonl'), toolLines.join('\n') + (toolLines.length > 0 ? '\n' : ''));

      // usage.jsonl
      const usageLines = rangeUsageEvents.map((u) =>
        JSON.stringify({
          id: u.id,
          conversationId: u.conversationId,
          actor: u.actor,
          provider: u.provider,
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          estimatedCostUsd: u.estimatedCostUsd,
          pricingStatus: u.pricingStatus,
          createdAt: u.createdAt,
        }),
      );
      writeFileSync(join(tempDir, 'usage.jsonl'), usageLines.join('\n') + (usageLines.length > 0 ? '\n' : ''));

      // llm_requests.jsonl — raw request/response payloads sent to the LLM provider
      const requestLogLines = rangeRequestLogs.map((r) => {
        let request: unknown;
        let response: unknown;
        try { request = JSON.parse(r.requestPayload); } catch { request = r.requestPayload; }
        try { response = JSON.parse(r.responsePayload); } catch { response = r.responsePayload; }
        return JSON.stringify({
          id: r.id,
          conversationId: r.conversationId,
          request: redactDeep(request),
          response: redactDeep(response),
          createdAt: r.createdAt,
        });
      });
      writeFileSync(join(tempDir, 'llm_requests.jsonl'), requestLogLines.join('\n') + (requestLogLines.length > 0 ? '\n' : ''));

      // 7. Zip the temp directory
      const downloadsDir = join(homedir(), 'Downloads');
      mkdirSync(downloadsDir, { recursive: true });
      const zipFilename = `${exportId}.zip`;
      const zipPath = join(downloadsDir, zipFilename);

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', (err: Error) => reject(err));
        archive.on('error', (err: Error) => reject(err));
        archive.on('warning', (err: Error) => {
          log.warn({ err }, 'Archiver warning during diagnostics export');
        });

        archive.pipe(output);
        archive.directory(tempDir, false);
        archive.finalize();
      });

      // 8. Send success response
      ctx.send(socket, {
        type: 'diagnostics_export_response',
        success: true,
        filePath: zipPath,
      });

      log.info({ conversationId, zipPath, messageCount: rangeMessages.length }, 'Diagnostics export completed');
    } finally {
      // Clean up temp directory
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, conversationId: msg.conversationId }, 'Failed to export diagnostics');
    ctx.send(socket, {
      type: 'diagnostics_export_response',
      success: false,
      error: `Failed to export diagnostics: ${errorMessage}`,
    });
  }
}

export const diagnosticsHandlers = defineHandlers({
  diagnostics_export_request: handleDiagnosticsExport,
});
