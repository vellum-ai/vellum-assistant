import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { AssistantConfig } from "../config/types.js";
import { BackendUnavailableError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getDb } from "./db-connection.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
} from "./embedding-backend.js";
import type { EmbeddingInput } from "./embedding-types.js";
import {
  embeddingInputContentHash,
  normalizeEmbeddingInput,
} from "./embedding-types.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { getQdrantClient } from "./qdrant-client.js";
import { memoryEmbeddings } from "./schema.js";

export { BackendUnavailableError };

const log = getLogger("memory-jobs-worker");

// ── Vector BLOB encoding/decoding ───────────────────────────────────

/** Encode a number[] into a compact Float32Array BLOB for SQLite storage. */
export function vectorToBlob(vector: number[]): Buffer {
  const f32 = new Float32Array(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Decode a BLOB (Buffer/Uint8Array) back into a number[]. */
export function blobToVector(buf: Buffer | Uint8Array): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

// ── Error classification for LLM / API errors ─────────────────────

export type ErrorCategory = "retryable" | "fatal";

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
export const RETRY_MAX_ATTEMPTS = 8;

/**
 * Classify an error as retryable or fatal based on its HTTP status or type.
 *
 * Retryable: timeouts, 429 rate limits, 5xx server errors, connection errors.
 * Fatal: 400 bad request, 401 auth, 403 permission, other 4xx client errors.
 */
export function classifyError(err: unknown): ErrorCategory {
  // Timeout errors from our own Promise.race wrappers
  if (err instanceof Error && err.message.includes("timeout")) {
    return "retryable";
  }

  // SDK APIError subclasses (Anthropic and OpenAI share the same shape)
  if (err != null && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    if (typeof status === "number") {
      if (status === 429) return "retryable";
      if (status >= 500) return "retryable";
      // 400, 401, 403, 404, 409, 422, other 4xx → fatal
      return "fatal";
    }
    // No status (connection error) → retryable
    return "retryable";
  }

  // Parse HTTP status codes from error messages (e.g., "request failed (429): ...")
  // Gemini and Ollama backends embed status codes in plain Error messages
  if (err instanceof Error) {
    const statusMatch = err.message.match(/\((\d{3})\)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      if (status === 429) return "retryable";
      if (status >= 500) return "retryable";
      // 4xx client errors → fatal
      if (status >= 400 && status < 500) return "fatal";
    }
  }

  // Connection/network errors without a status code.
  // Check both the message (Node.js style) and the `code` property (Bun style,
  // e.g. code: "ConnectionRefused" from Bun's HTTP client).
  if (err instanceof Error) {
    if (
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(
        err.message,
      )
    ) {
      return "retryable";
    }
    const code = (err as Error & { code?: string }).code;
    if (
      typeof code === "string" &&
      /^Connection(Refused|Reset|Timeout)|NetworkUnreachable|Unable.?to.?connect/i.test(
        code,
      )
    ) {
      return "retryable";
    }
  }

  // BackendUnavailableError is transient — the provider or backend may come back online
  if (err instanceof BackendUnavailableError) {
    return "retryable";
  }

  // Unknown errors default to fatal to avoid infinite retry loops
  return "fatal";
}

/** Equal jitter backoff: floor of cap/2 plus random in [0, cap/2].
 *  Prevents retry delays from collapsing to 0ms while still avoiding thundering herds. */
export function retryDelayForAttempt(attempts: number): number {
  const cap = Math.min(
    RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1)),
    RETRY_MAX_DELAY_MS,
  );
  const half = cap / 2;
  return half + Math.random() * half;
}

// ── Payload extraction helpers ─────────────────────────────────────

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asPositiveMs(value: unknown): number | null {
  if (typeof value !== "number") return null;
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
  targetType:
    | "segment"
    | "item"
    | "summary"
    | "media"
    | "graph_node"
    | "pkb_file",
  targetId: string,
  input: EmbeddingInput,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const status = await getMemoryBackendStatus(config);
  if (!status.provider) {
    throw new BackendUnavailableError(
      `Embedding backend unavailable (${status.reason ?? "no provider"})`,
    );
  }

  const contentHash = embeddingInputContentHash(input);
  let provider = status.provider;
  let model = status.model!;
  let vector: number[];

  // Check SQLite embedding cache for a matching content hash (primary provider only).
  const db = getDb();
  const expectedDim = config.memory.qdrant.vectorSize;
  let cachedRow = db
    .select({
      vectorBlob: memoryEmbeddings.vectorBlob,
      vectorJson: memoryEmbeddings.vectorJson,
      dimensions: memoryEmbeddings.dimensions,
    })
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
    // Prefer BLOB (compact), fall back to JSON for unmigrated rows
    if (cachedRow.vectorBlob) {
      vector = blobToVector(cachedRow.vectorBlob as Buffer);
    } else {
      vector = JSON.parse(cachedRow.vectorJson!);
    }
  } else {
    const embedded = await embedWithBackend(config, [input]);
    vector = embedded.vectors[0];
    if (!vector) return;
    provider = embedded.provider;
    model = embedded.model;
  }

  // Extract text for Qdrant payload: use the raw text for text inputs,
  // or a description string for non-text (image/audio/video) inputs.
  const normalized = normalizeEmbeddingInput(input);
  const payloadText =
    normalized.type === "text"
      ? normalized.text
      : `[${normalized.type}:${normalized.mimeType}]`;

  // Generate sparse embedding from the same source text used for dense embedding.
  // For non-text (media) inputs, sparse vectors are skipped since tokenization
  // only applies to text content.
  const sparseVector =
    normalized.type === "text"
      ? generateSparseEmbedding(normalized.text)
      : undefined;

  // Persist embedding in SQLite for cross-restart cache
  const now = Date.now();
  try {
    const blobValue = vectorToBlob(vector);
    db.insert(memoryEmbeddings)
      .values({
        id: randomUUID(),
        targetType,
        targetId,
        provider,
        model,
        dimensions: vector.length,
        vectorBlob: blobValue,
        vectorJson: null,
        contentHash,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          memoryEmbeddings.targetType,
          memoryEmbeddings.targetId,
          memoryEmbeddings.provider,
          memoryEmbeddings.model,
        ],
        set: {
          vectorBlob: blobValue,
          vectorJson: null,
          dimensions: vector.length,
          contentHash,
          updatedAt: now,
        },
      })
      .run();
  } catch (err) {
    log.warn({ err, targetType, targetId }, "Failed to write embedding cache");
  }

  let qdrant;
  try {
    qdrant = getQdrantClient();
  } catch {
    throw new BackendUnavailableError("Qdrant client not initialized");
  }

  try {
    const modality = normalized.type;
    await withQdrantBreaker(() =>
      qdrant.upsert(
        targetType,
        targetId,
        vector,
        {
          text: payloadText,
          modality,
          created_at: (extraPayload?.created_at as number) ?? now,
          ...(extraPayload as Record<string, unknown> | undefined),
        },
        sparseVector,
      ),
    );
  } catch (err) {
    log.warn(
      { err, targetType, targetId },
      "Failed to upsert embedding to Qdrant",
    );
    throw err;
  }
}
