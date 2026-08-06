/**
 * Telegram Bot API client for direct outbound messaging.
 *
 * Calls the Telegram Bot API directly using bot_token from the secure store,
 * eliminating the gateway HTTP proxy hop. Retry logic, error classification,
 * and payload shapes mirror the gateway's telegram/api.ts so behavior is
 * identical.
 */

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyResultAsync } from "../../../security/secure-keys.js";
import { BackendUnavailableError, ConfigError } from "../../../util/errors.js";
import { getLogger } from "../../../util/logger.js";
import { retryableCall } from "../retry-policy.js";

const log = getLogger("telegram-api");

const TELEGRAM_API_BASE = "https://api.telegram.org";

const TELEGRAM_DEFAULT_MAX_RETRIES = 3;
const TELEGRAM_DEFAULT_INITIAL_BACKOFF_MS = 1000;
const TELEGRAM_DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * A Telegram Bot API call that returned a non-retryable client error (a 4xx
 * with `ok: false`). The request itself is the problem — the chat, the method,
 * or the payload — so retrying the same call is pointless. `description` carries
 * Telegram's human-readable error text when present.
 *
 * Callers branch on this type to degrade gracefully: e.g. a rejected
 * `sendRichMessage` falls back to a plain-text `sendMessage`. Branch on the
 * type, not on `error_code` — the docs warn the numeric code is "subject to
 * change" (https://core.telegram.org/bots/api#making-requests).
 */
export class TelegramNonRetryableError extends Error {
  readonly description: string | undefined;

  constructor(message: string, description?: string) {
    super(message);
    this.name = "TelegramNonRetryableError";
    this.description = description;
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

/** The Bot API envelope, or undefined when the body is not JSON. */
function parseTelegramBody<T>(
  body: string,
): TelegramApiResponse<T> | undefined {
  try {
    return JSON.parse(body) as TelegramApiResponse<T>;
  } catch {
    return undefined;
  }
}

function telegramCall<T>(
  method: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  return retryableCall<T>({
    provider: "Telegram",
    operation: method,
    maxRetries: TELEGRAM_DEFAULT_MAX_RETRIES,
    initialBackoffMs: TELEGRAM_DEFAULT_INITIAL_BACKOFF_MS,
    log,
    doFetch,
    // Telegram errors can echo the bot token, which is in the request URL.
    redact: redactBotTokens,
    detailFrom: (body) => parseTelegramBody<T>(body)?.description,
    retryAfterFrom: (_response, body) => {
      const retryAfter = parseTelegramBody<T>(body)?.parameters?.retry_after;
      return retryAfter != null ? String(retryAfter) : null;
    },
    nonRetryableError: ({ message, detail }) =>
      new TelegramNonRetryableError(message, detail),
    decode: (body, response) => {
      const data = parseTelegramBody<T>(body);
      if (!data) {
        throw new Error(
          body
            ? `Telegram ${method} failed: unparseable response body: ${redactBotTokens(body)}`
            : `Telegram ${method} failed with status ${response.status}: empty response`,
        );
      }
      // A 200 can still carry a failure: the Bot API reports it in the
      // envelope rather than the status.
      if (!data.ok || data.result === undefined) {
        throw new Error(
          data.description
            ? `Telegram ${method} failed: ${data.description}`
            : `Telegram ${method} failed with status ${response.status}`,
        );
      }
      return data.result;
    },
  });
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveBotToken(): Promise<string> {
  const result = await getSecureKeyResultAsync(
    credentialKey("telegram", "bot_token"),
  );
  if (result.value) {
    return result.value;
  }
  // Distinguish a transient credential-store outage from a token that was
  // genuinely never set. Both surface as an absent value, but only the
  // latter is an operator misconfiguration; the former is retryable
  // infrastructure unavailability that callers should not treat as
  // "not configured".
  if (result.unreachable) {
    throw new BackendUnavailableError("Telegram credential store unreachable");
  }
  throw new ConfigError("Telegram bot token not configured");
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
  return telegramCall<T>(method, () =>
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
  return telegramCall<T>(method, () =>
    fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_DEFAULT_TIMEOUT_MS),
    }),
  );
}
