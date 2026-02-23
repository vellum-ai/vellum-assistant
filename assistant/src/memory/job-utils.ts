import { createHash, randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getLogger } from '../util/logger.js';
import { embedWithBackend, getMemoryBackendStatus } from './embedding-backend.js';
import { getDb } from './db.js';
import { getQdrantClient } from './qdrant-client.js';
import { memoryEmbeddings } from './schema.js';
import type { AssistantConfig } from '../config/types.js';

const log = getLogger('memory-jobs-worker');

// ── Sentinel error ─────────────────────────────────────────────────

/** Sentinel error: the embedding backend is not configured yet. */
export class BackendUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BackendUnavailableError';
  }
}

// ── Error classification for LLM / API errors ─────────────────────

export type ErrorCategory = 'retryable' | 'fatal';

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
export const RETRY_MAX_ATTEMPTS = 8;

/**
 * Classify an error as retryable or fatal based on its HTTP status or type.
 *
 * Retryable: timeouts, 429 rate limits, 5xx server errors, connection errors.
 * Fatal: 400 bad request, 401 auth, 403 permission, other 4xx client errors.
 */
export function classifyError(err: unknown): ErrorCategory {
  // Timeout errors from our own Promise.race wrappers
  if (err instanceof Error && err.message.includes('timeout')) {
    return 'retryable';
  }

  // SDK APIError subclasses (Anthropic and OpenAI share the same shape)
  if (err != null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      if (status === 429) return 'retryable';
      if (status >= 500) return 'retryable';
      // 400, 401, 403, 404, 409, 422, other 4xx → fatal
      return 'fatal';
    }
    // No status (connection error) → retryable
    return 'retryable';
  }

  // Parse HTTP status codes from error messages (e.g., "request failed (429): ...")
  // Gemini and Ollama backends embed status codes in plain Error messages
  if (err instanceof Error) {
    const statusMatch = err.message.match(/\((\d{3})\)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      if (status === 429) return 'retryable';
      if (status >= 500) return 'retryable';
      // 4xx client errors → fatal
      if (status >= 400 && status < 500) return 'fatal';
    }
  }

  // Connection/network errors without a status code
  if (err instanceof Error && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(err.message)) {
    return 'retryable';
  }

  // Unknown errors default to fatal to avoid infinite retry loops
  return 'fatal';
}

/** Equal jitter backoff: floor of cap/2 plus random in [0, cap/2].
 *  Prevents retry delays from collapsing to 0ms while still avoiding thundering herds. */
export function retryDelayForAttempt(attempts: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1)), RETRY_MAX_DELAY_MS);
  const half = cap / 2;
  return half + Math.random() * half;
}

// ── Payload extraction helpers ─────────────────────────────────────

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asPositiveMs(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

// ── Embedding helper ───────────────────────────────────────────────

export async function embedAndUpsert(
  config: AssistantConfig,
  targetType: 'segment' | 'item' | 'summary',
  targetId: string,
  text: string,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const status = getMemoryBackendStatus(config);
  if (!status.provider) {
    throw new BackendUnavailableError(
      `Embedding backend unavailable (${status.reason ?? 'no provider'})`,
    );
  }

  const contentHash = createHash('sha256').update(text).digest('hex');
  let provider = status.provider;
  let model = status.model!;
  let vector: number[];

  // Check SQLite embedding cache for a matching content hash (primary provider only).
  const db = getDb();
  const expectedDim = config.memory.qdrant.vectorSize;
  let cachedRow = db
    .select({ vectorJson: memoryEmbeddings.vectorJson, dimensions: memoryEmbeddings.dimensions })
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.contentHash, contentHash),
        eq(memoryEmbeddings.provider, provider),
        eq(memoryEmbeddings.model, model),
      ),
    )
    .get();
  if (cachedRow && cachedRow.dimensions !== expectedDim) cachedRow = undefined;

  if (cachedRow) {
    vector = JSON.parse(cachedRow.vectorJson);
  } else {
    const embedded = await embedWithBackend(config, [text]);
    vector = embedded.vectors[0];
    if (!vector) return;
    provider = embedded.provider;
    model = embedded.model;
  }

  // Persist embedding in SQLite for cross-restart cache
  const now = Date.now();
  try {
    db.insert(memoryEmbeddings)
      .values({
        id: randomUUID(),
        targetType,
        targetId,
        provider,
        model,
        dimensions: vector.length,
        vectorJson: JSON.stringify(vector),
        contentHash,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [memoryEmbeddings.targetType, memoryEmbeddings.targetId, memoryEmbeddings.provider, memoryEmbeddings.model],
        set: {
          vectorJson: JSON.stringify(vector),
          dimensions: vector.length,
          contentHash,
          updatedAt: now,
        },
      })
      .run();
  } catch (err) {
    log.warn({ err, targetType, targetId }, 'Failed to write embedding cache');
  }

  let qdrant;
  try {
    qdrant = getQdrantClient();
  } catch {
    throw new BackendUnavailableError('Qdrant client not initialized');
  }

  try {
    await qdrant.upsert(targetType, targetId, vector, {
      text,
      created_at: (extraPayload?.created_at as number) ?? now,
      ...(extraPayload as Record<string, unknown> | undefined),
    });
  } catch (err) {
    log.warn({ err, targetType, targetId }, 'Failed to upsert embedding to Qdrant');
    throw err;
  }
}

// ── Time window utilities ──────────────────────────────────────────

export function currentWeekWindow(now: Date): { scopeKey: string; startMs: number; endMs: number } {
  const day = (now.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - day,
    0,
    0,
    0,
    0,
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  const scopeKey = `${start.getUTCFullYear()}-W${weekNumber(start).toString().padStart(2, '0')}`;
  return { scopeKey, startMs: start.getTime(), endMs: end.getTime() };
}

export function currentMonthWindow(now: Date): { scopeKey: string; startMs: number; endMs: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const scopeKey = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { scopeKey, startMs: start.getTime(), endMs: end.getTime() };
}

function weekNumber(date: Date): number {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
