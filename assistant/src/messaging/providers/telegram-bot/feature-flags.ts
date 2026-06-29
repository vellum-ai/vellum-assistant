/**
 * Feature gate for Telegram rich-message delivery (Bot API 10.1).
 *
 * When enabled, the Telegram transport sends replies via `sendRichMessage`
 * (forwarding GFM markdown) instead of plain `sendMessage`. Off by default so
 * the richer path rolls out behind a kill switch; a failed rich send always
 * degrades to plain text regardless of this flag.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../../config/schema.js";

const TELEGRAM_RICH_MESSAGES_FLAG = "telegram-rich-messages" as const;

export function isTelegramRichMessagesEnabled(
  config: AssistantConfig,
): boolean {
  return isAssistantFeatureFlagEnabled(TELEGRAM_RICH_MESSAGES_FLAG, config);
}
