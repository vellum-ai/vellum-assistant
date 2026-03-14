import { getConfig } from "../config/loader.js";

/**
 * Read the Telegram bot ID from config.
 */
export function getTelegramBotId(): string | undefined {
  const value = getConfig().telegram.botId;
  if (value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Read the Telegram bot username from config.
 */
export function getTelegramBotUsername(): string | undefined {
  const value = getConfig().telegram.botUsername;
  if (value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
