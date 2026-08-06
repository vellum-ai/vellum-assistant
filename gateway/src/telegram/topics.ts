/**
 * Helpers for Telegram Private Chat Topics (BotFather Threaded Mode).
 */

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";

export function buildTelegramDeliverUrl(
  gatewayInternalBaseUrl: string,
  threadId?: string,
): string {
  const base = `${gatewayInternalBaseUrl}/deliver/telegram`;
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return base;
  }
  const params = new URLSearchParams({ threadId: trimmed });
  return `${base}?${params}`;
}

export function telegramSendOpts(
  caches:
    | { credentials?: CredentialCache; configFile?: ConfigFileCache }
    | undefined,
  threadId?: string,
): {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
  messageThreadId?: string;
} {
  const trimmed = threadId?.trim();
  return {
    credentials: caches?.credentials,
    configFile: caches?.configFile,
    ...(trimmed ? { messageThreadId: trimmed } : {}),
  };
}

export type TelegramTopicApiCaches = {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
};

/** Unused config param kept so callers can pass GatewayConfig uniformly. */
export type TelegramTopicContext = {
  config: GatewayConfig;
  caches?: TelegramTopicApiCaches;
  chatId: string;
  threadId?: string;
};
