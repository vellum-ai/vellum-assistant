import type { ChannelId } from "../../../channels/types.js";
import { getLogger } from "../../../util/logger.js";
import { deliverChannelReply } from "../../gateway-client.js";

const log = getLogger("runtime-http");

/**
 * Telegram's typing indicator expires after ~5s of inactivity, so the
 * heartbeat has to stay under that expiry or the indicator blinks off
 * between beats; anyone changing it should check the current window first.
 *
 * No explicit stop is needed on the delivery path: Telegram clears the
 * status as soon as the bot sends a message.
 *
 * https://core.telegram.org/bots/api#sendchataction
 */
const TELEGRAM_TYPING_INTERVAL_MS = 4_000;

export function shouldEmitTelegramTyping(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  if (sourceChannel !== "telegram" || !replyCallbackUrl) {
    return false;
  }
  try {
    return new URL(replyCallbackUrl).pathname.endsWith("/deliver/telegram");
  } catch {
    return replyCallbackUrl.endsWith("/deliver/telegram");
  }
}

export function startTelegramTypingHeartbeat(
  callbackUrl: string,
  chatId: string,
  assistantId?: string,
): () => void {
  let active = true;
  let inFlight = false;

  const emitTyping = (): void => {
    if (!active || inFlight) {
      return;
    }
    inFlight = true;
    void deliverChannelReply(callbackUrl, {
      chatId,
      chatAction: "typing",
      assistantId,
    })
      .catch((err) => {
        log.debug(
          { err, chatId },
          "Failed to deliver Telegram typing indicator",
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  emitTyping();

  const interval = setInterval(emitTyping, TELEGRAM_TYPING_INTERVAL_MS);
  (interval as { unref?: () => void }).unref?.();

  return () => {
    active = false;
    clearInterval(interval);
  };
}
