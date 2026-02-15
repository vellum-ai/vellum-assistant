import type { GatewayConfig } from "../config.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function callTelegramApi<T>(
  config: GatewayConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${config.telegramApiBaseUrl}/bot${config.telegramBotToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.telegramTimeoutMs),
  });

  const data = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(
      data.description
        ? `Telegram ${method} failed: ${data.description}`
        : `Telegram ${method} failed with status ${response.status}`,
    );
  }

  return data.result;
}

export async function callTelegramApiMultipart<T>(
  config: GatewayConfig,
  method: string,
  form: FormData,
): Promise<T> {
  const url = `${config.telegramApiBaseUrl}/bot${config.telegramBotToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(config.telegramTimeoutMs),
  });

  const data = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(
      data.description
        ? `Telegram ${method} failed: ${data.description}`
        : `Telegram ${method} failed with status ${response.status}`,
    );
  }

  return data.result;
}
