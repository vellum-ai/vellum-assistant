import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import { retryableFetch } from "../util/retryable-fetch.js";

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

function buildTelegramFailureMessage(
  method: string,
  status: number,
  description: string | undefined,
  body: string,
): string {
  return description
    ? `Telegram ${method} failed: ${description}`
    : body
      ? `Telegram ${method} failed with status ${status}: ${redactTelegramBotTokens(body)}`
      : `Telegram ${method} failed with status ${status}`;
}

async function readTelegramErrorBody(response: Response): Promise<{
  body: string;
  description: string | undefined;
  retryAfterParam: number | undefined;
}> {
  const body = await response.text().catch(() => "");
  let description: string | undefined;
  let retryAfterParam: number | undefined;
  try {
    const data = JSON.parse(body) as TelegramApiResponse<unknown>;
    description = data.description;
    retryAfterParam = data.parameters?.retry_after;
  } catch {
    // Response body is not JSON; the raw text is still returned for messages
  }
  return { body, description, retryAfterParam };
}

async function retryableTelegramFetch<T>(
  configFile: ConfigFileCache | undefined,
  method: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  return retryableFetch<T>(
    {
      provider: "Telegram",
      operation: method,
      log,
      configFile,
      configSection: "telegram",
      doFetch,
    },
    {
      summarizeFetchError,
      throwTerminal: async (response) => {
        const { body, description } = await readTelegramErrorBody(response);
        throw new Error(
          buildTelegramFailureMessage(
            method,
            response.status,
            description,
            body,
          ),
        );
      },
      describeRetryable: async (response) => {
        const { body, description, retryAfterParam } =
          await readTelegramErrorBody(response);
        return {
          retryAfter:
            response.headers.get("retry-after") ??
            (retryAfterParam != null ? String(retryAfterParam) : null),
          error: new Error(
            buildTelegramFailureMessage(
              method,
              response.status,
              description,
              body,
            ),
          ),
        };
      },
      parseSuccess: async (response) => {
        const body = await response.text().catch(() => "");
        let data: TelegramApiResponse<T>;
        try {
          data = JSON.parse(body) as TelegramApiResponse<T>;
        } catch {
          throw new Error(
            body
              ? `Telegram ${method} failed: unparseable response body: ${redactTelegramBotTokens(body)}`
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
      },
    },
  );
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

  return retryableTelegramFetch<T>(opts?.configFile, method, () =>
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

  return retryableTelegramFetch<T>(opts?.configFile, method, () =>
    fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}
