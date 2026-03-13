import { getConfig } from "../config/loader.js";

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
