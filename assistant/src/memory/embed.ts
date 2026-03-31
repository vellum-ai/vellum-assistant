// ---------------------------------------------------------------------------
// Shared embedding utility with retry + exponential backoff
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../config/types.js";
import { getLogger } from "../util/logger.js";
import {
  abortableSleep,
  computeRetryDelay,
  isRetryableNetworkError,
} from "../util/retry.js";
import { embedWithBackend } from "./embedding-backend.js";

const log = getLogger("memory-embed");

const EMBED_MAX_RETRIES = 3;
const EMBED_BASE_DELAY_MS = 500;

/**
 * Wrap embedWithBackend with retry + exponential backoff for transient failures
 * (network errors, 429s, 5xx). Aborts immediately if the caller's signal fires.
 */
export async function embedWithRetry(
  config: AssistantConfig,
  texts: string[],
  opts?: { signal?: AbortSignal },
): ReturnType<typeof embedWithBackend> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      return await embedWithBackend(config, texts, opts);
    } catch (err) {
      lastError = err;
      if (opts?.signal?.aborted || isAbortError(err)) throw err;
      const isTransient =
        isRetryableNetworkError(err) || isHttpStatusError(err);
      if (!isTransient || attempt === EMBED_MAX_RETRIES) throw err;
      const delay = computeRetryDelay(attempt, EMBED_BASE_DELAY_MS);
      log.warn(
        { err, attempt: attempt + 1, delayMs: Math.round(delay) },
        "Transient embedding failure, retrying",
      );
      await abortableSleep(delay, opts?.signal);
      if (opts?.signal?.aborted) throw err;
    }
  }
  throw lastError;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "APIUserAbortError";
}

function getErrorStatusCode(err: Error): unknown {
  if ("status" in err) {
    const status = (err as { status: unknown }).status;
    if (status != null) return status;
  }
  if ("statusCode" in err) return (err as { statusCode: unknown }).statusCode;
  return undefined;
}

function isHttpStatusError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = getErrorStatusCode(err);
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status < 600);
  }
  return /\b429\b|(?:failed|error)\s*\((?:429|5\d{2})\)|(?:status|http)\s*(?:code\s*)?:?\s*5\d{2}\b/i.test(
    err.message,
  );
}
