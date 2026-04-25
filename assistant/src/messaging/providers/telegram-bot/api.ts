/**
 * Telegram Bot API client for direct outbound messaging.
 *
 * Calls the Telegram Bot API directly using bot_token from the secure store,
 * eliminating the gateway HTTP proxy hop. Retry logic, error classification,
 * and payload shapes mirror the gateway's telegram/api.ts so behavior is
 * identical.
 */

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("telegram-api");

const TELEGRAM_API_BASE = "https://api.telegram.org";

const TELEGRAM_DEFAULT_MAX_RETRIES = 3;
const TELEGRAM_DEFAULT_INITIAL_BACKOFF_MS = 1000;
const TELEGRAM_DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class TelegramNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramNonRetryableError";
  }
}

// ---------------------------------------------------------------------------
// Bot token redaction
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN_IN_URL_PATTERN =
  /\/bot\d{8,10}:[A-Za-z0-9_-]{30,120}\//g;
const TELEGRAM_BOT_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_])\d{8,10}:[A-Za-z0-9_-]{30,120}(?![A-Za-z0-9_])/g;

function redactBotTokens(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_IN_URL_PATTERN, "/bot[REDACTED]/")
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function computeDelay(
  attempt: number,
  initialBackoffMs: number,
  retryAfterHeader: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 2_147_483_647);
    }
    const targetTime = new Date(retryAfterHeader).getTime();
    if (Number.isFinite(targetTime)) {
      const delayMs = targetTime - Date.now();
      if (delayMs > 0) return Math.min(delayMs, 2_147_483_647);
    }
  }
  const exponential = initialBackoffMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

async function retryableFetch<T>(
  method: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= TELEGRAM_DEFAULT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = computeDelay(
        attempt,
        TELEGRAM_DEFAULT_INITIAL_BACKOFF_MS,
        lastRetryAfter,
      );
      log.debug({ attempt, delay, method }, "Retrying Telegram API call");
      await new Promise((r) => setTimeout(r, delay));
    }

    lastRetryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(
        `Telegram ${method} request failed: ${redactBotTokens(message)}`,
      );
      log.warn(
        { error: redactBotTokens(message), attempt, method },
        "Telegram API fetch failed",
      );
      continue;
    }

    if (!isRetryable(response.status) && !response.ok) {
      const body = await response.text().catch(() => "");
      let description: string | undefined;
      try {
        const data = JSON.parse(body) as TelegramApiResponse<T>;
        description = data.description;
      } catch {
        // not JSON
      }
      const message = description
        ? `Telegram ${method} failed: ${description}`
        : body
          ? `Telegram ${method} failed with status ${response.status}: ${redactBotTokens(body)}`
          : `Telegram ${method} failed with status ${response.status}`;

      throw new TelegramNonRetryableError(message);
    }

    if (isRetryable(response.status)) {
      const body = await response.text().catch(() => "");
      let description: string | undefined;
      let retryAfterParam: number | undefined;
      try {
        const data = JSON.parse(body) as TelegramApiResponse<T>;
        description = data.description;
        retryAfterParam = data.parameters?.retry_after;
      } catch {
        // not JSON
      }
      lastRetryAfter =
        response.headers.get("retry-after") ??
        (retryAfterParam != null ? String(retryAfterParam) : null);
      lastError = new Error(
        description
          ? `Telegram ${method} failed: ${description}`
          : body
            ? `Telegram ${method} failed with status ${response.status}: ${redactBotTokens(body)}`
            : `Telegram ${method} failed with status ${response.status}`,
      );
      log.warn(
        {
          status: response.status,
          attempt,
          method,
          retryAfter: lastRetryAfter,
        },
        "Telegram API returned retryable error",
      );
      continue;
    }

    const body = await response.text().catch(() => "");
    let data: TelegramApiResponse<T>;
    try {
      data = JSON.parse(body) as TelegramApiResponse<T>;
    } catch {
      throw new Error(
        body
          ? `Telegram ${method} failed: unparseable response body: ${redactBotTokens(body)}`
          : `Telegram ${method} failed with status ${response.status}: empty response`,
      );
    }
    if (!data.ok || data.result === undefined) {
      throw new Error(
        data.description
          ? `Telegram ${method} failed: ${data.description}`
          : `Telegram ${method} failed with status ${response.status}`,
      );
    }

    return data.result;
  }

  throw lastError ?? new Error(`Telegram ${method} failed after retries`);
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveBotToken(): Promise<string> {
  const botToken = await getSecureKeyAsync(
    credentialKey("telegram", "bot_token"),
  );
  if (!botToken) {
    throw new Error("Telegram bot token not configured");
  }
  return botToken;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  date: number;
  text?: string;
}

/**
 * Call a Telegram Bot API method with a JSON body.
 */
export async function callTelegramBotApi<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const botToken = await resolveBotToken();
  return retryableFetch<T>(method, () =>
    fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_DEFAULT_TIMEOUT_MS),
    }),
  );
}

/**
 * Call a Telegram Bot API method with a multipart/form-data body.
 */
export async function callTelegramBotApiMultipart<T>(
  method: string,
  form: FormData,
): Promise<T> {
  const botToken = await resolveBotToken();
  return retryableFetch<T>(method, () =>
    fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_DEFAULT_TIMEOUT_MS),
    }),
  );
}
