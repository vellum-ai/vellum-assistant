import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("telegram-api");

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

const TELEGRAM_BOT_TOKEN_IN_URL_PATTERN =
  /\/bot\d{8,10}:[A-Za-z0-9_-]{30,120}\//g;
const TELEGRAM_BOT_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_])\d{8,10}:[A-Za-z0-9_-]{30,120}(?![A-Za-z0-9_])/g;

function redactTelegramBotTokens(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_IN_URL_PATTERN, "/bot[REDACTED]/")
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, "[REDACTED]");
}

function summarizeFetchError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else {
    parts.push(String(err));
  }

  const path = (err as { path?: unknown })?.path;
  if (typeof path === "string" && path.length > 0) {
    parts.push(`path=${path}`);
  }

  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.length > 0) {
    parts.push(`code=${code}`);
  }

  return redactTelegramBotTokens(parts.join(" "));
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
    // Try parsing as numeric seconds first (e.g., "120")
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      // Clamp to max 32-bit signed int to prevent setTimeout overflow
      return Math.min(seconds * 1000, 2_147_483_647);
    }

    // Fall back to HTTP-date format (e.g., "Fri, 31 Dec 1999 23:59:59 GMT")
    const targetTime = new Date(retryAfterHeader).getTime();
    if (Number.isFinite(targetTime)) {
      const delayMs = targetTime - Date.now();
      if (delayMs > 0) {
        // Clamp to max 32-bit signed int to prevent setTimeout overflow
        return Math.min(delayMs, 2_147_483_647);
      }
    }
  }

  const exponential = initialBackoffMs * Math.pow(2, attempt - 1);
  // Add jitter: 0–50% of the computed delay
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

async function retryableFetch<T>(
  configFile: ConfigFileCache | undefined,
  method: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  const maxRetries = configFile?.getNumber("telegram", "maxRetries") ?? 3;
  const initialBackoffMs =
    configFile?.getNumber("telegram", "initialBackoffMs") ?? 1000;

  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeDelay(attempt, initialBackoffMs, lastRetryAfter);
      log.debug({ attempt, delay, method }, "Retrying Telegram API call");
      await new Promise((r) => setTimeout(r, delay));
    }

    lastRetryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const safeError = summarizeFetchError(err);
      lastError = new Error(`Telegram ${method} request failed: ${safeError}`);
      log.warn(
        { error: safeError, attempt, method },
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
        // Response body is not JSON — include raw text if available
      }
      throw new Error(
        description
          ? `Telegram ${method} failed: ${description}`
          : body
            ? `Telegram ${method} failed with status ${response.status}: ${body}`
            : `Telegram ${method} failed with status ${response.status}`,
      );
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
        // Response body is not JSON
      }
      lastRetryAfter =
        response.headers.get("retry-after") ??
        (retryAfterParam != null ? String(retryAfterParam) : null);
      lastError = new Error(
        description
          ? `Telegram ${method} failed: ${description}`
          : body
            ? `Telegram ${method} failed with status ${response.status}: ${body}`
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
          ? `Telegram ${method} failed: unparseable response body: ${body}`
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

export async function callTelegramApi<T>(
  method: string,
  body: Record<string, unknown>,
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<T> {
  let botToken: string | undefined;
  if (opts?.credentials) {
    botToken = await opts.credentials.get(
      credentialKey("telegram", "bot_token"),
    );
  }

  if (!botToken) {
    throw new Error(
      `Telegram ${method} failed: botToken is not available (credentials not provided or credential cache returned undefined)`,
    );
  }

  const apiBaseUrl =
    opts?.configFile?.getString("telegram", "apiBaseUrl") ??
    "https://api.telegram.org";
  const timeoutMs =
    opts?.configFile?.getNumber("telegram", "timeoutMs") ?? 15000;

  return retryableFetch<T>(opts?.configFile, method, () =>
    fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

export async function callTelegramApiMultipart<T>(
  method: string,
  form: FormData,
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<T> {
  let botToken: string | undefined;
  if (opts?.credentials) {
    botToken = await opts.credentials.get(
      credentialKey("telegram", "bot_token"),
    );
  }

  if (!botToken) {
    throw new Error(
      `Telegram ${method} failed: botToken is not available (credentials not provided or credential cache returned undefined)`,
    );
  }

  const apiBaseUrl =
    opts?.configFile?.getString("telegram", "apiBaseUrl") ??
    "https://api.telegram.org";
  const timeoutMs =
    opts?.configFile?.getNumber("telegram", "timeoutMs") ?? 15000;

  return retryableFetch<T>(opts?.configFile, method, () =>
    fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}
