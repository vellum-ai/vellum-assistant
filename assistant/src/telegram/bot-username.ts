import { getConfig } from "../config/loader.js";

/**
 * Read the Telegram bot username from config, falling back to the
 * TELEGRAM_BOT_USERNAME env var.
 */
export function getTelegramBotUsername(): string | undefined {
  const value = getConfig().telegram.botUsername;
  if (value.trim().length > 0) {
    return value.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}
