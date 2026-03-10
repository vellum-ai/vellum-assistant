import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";
import type { ChannelDeliveryResult } from "./gateway-client.js";
import { deliverChannelReply } from "./gateway-client.js";

const log = getLogger("telegram-streaming-delivery");

const EDIT_THROTTLE_MS = 1000; // Min interval between edits
const TELEGRAM_MAX_TEXT_LEN = 4000; // Max chars per Telegram message
const MIN_INITIAL_CHARS = 20; // Min chars before sending first message

export interface TelegramStreamingOptions {
  callbackUrl: string;
  chatId: string;
  mintBearerToken: () => string;
  assistantId?: string;
}

export class TelegramStreamingDelivery {
  private readonly opts: TelegramStreamingOptions;
  private buffer = ""; // Accumulated text not yet sent
  private currentMessageId: number | null = null; // ID of current Telegram message
  private currentMessageText = ""; // Full text of current message
  private lastSentText = ""; // Last text successfully sent to Telegram
  private lastEditAt = 0; // Timestamp of last edit
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private messageCount = 0; // Total messages sent
  private finished = false;
  private textDelivered = false; // True once at least some text was sent
  private finishOk = false; // True only when finish() completes without error
  private initialSendInFlight = false; // Synchronous guard against duplicate initial sends
  private initialSendPromise: Promise<ChannelDeliveryResult> | null = null; // Tracks in-flight initial send

  constructor(opts: TelegramStreamingOptions) {
    this.opts = opts;
  }

  // ── Public API ──────────────────────────────────────────────────────

  onEvent(msg: ServerMessage): void {
    if (this.finished) return;
    switch (msg.type) {
      case "assistant_text_delta":
        this.onTextDelta(msg.text);
        break;
      case "tool_use_preview_start":
        // Early preview of tool use — ignored by Telegram; full tool_use_start follows.
        break;
      case "tool_use_start":
        // Flush buffer and send an edit so the message is up-to-date before the tool runs
        if (this.buffer.length > 0 && this.currentMessageId) {
          this.flushEdit();
        } else if (this.buffer.length > 0) {
          // No message sent yet — just move buffer to currentMessageText
          this.currentMessageText += this.buffer;
          this.buffer = "";
        }
        break;
      case "message_complete":
        // Don't finalize here — let finish() handle it
        break;
    }
  }

  async finish(approval?: ApprovalUIMetadata): Promise<void> {
    this.finished = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    // If sendInitialMessage() is in-flight, wait for it so currentMessageId is resolved
    if (this.initialSendPromise) {
      await this.initialSendPromise.catch(() => {
        // Error already logged in sendInitialMessage; proceed with whatever state we have
      });
    }

    // Flush any remaining buffered text
    if (this.buffer.length > 0) {
      if (this.currentMessageId) {
        this.currentMessageText += this.buffer;
        this.buffer = "";
      } else {
        log.warn(
          {
            chatId: this.opts.chatId,
            bufferLen: this.buffer.length,
            currentMessageTextLen: this.currentMessageText.length,
            textDelivered: this.textDelivered,
            initialSendInFlight: this.initialSendInFlight,
          },
          "finish() sending as new message because currentMessageId is null",
        );
        if (this.textDelivered) {
          // Initial text already delivered but no messageId — just send remainder
          this.currentMessageText = this.buffer;
        } else {
          // Initial send failed, buffer has been restored — send everything
          this.currentMessageText += this.buffer;
        }
        this.buffer = "";
        // Send as new message
        await this.sendNewMessage(this.currentMessageText, approval);
        this.finishOk = true;
        return;
      }
    }

    // Buffer was empty but text was moved to currentMessageText (e.g. by
    // tool_use_start) before any Telegram message was created. Send it now.
    if (
      !this.currentMessageId &&
      !this.textDelivered &&
      this.currentMessageText.length > 0 &&
      this.buffer.length === 0
    ) {
      await this.sendNewMessage(this.currentMessageText, approval);
      this.finishOk = true;
      return;
    }

    // Final edit with approval buttons if present.
    // Skip the edit when text hasn't changed since the last successful
    // delivery and there are no approval buttons to attach — sending the
    // same text again would trigger Telegram's "message is not modified"
    // 400 error.
    if (this.currentMessageId && (this.currentMessageText || approval)) {
      if (!approval && this.currentMessageText === this.lastSentText) {
        this.finishOk = true;
        return;
      }

      // Enforce Telegram length limits: if the final text exceeds the max,
      // split it the same way flushEdit() does — finalize the current message
      // with text up to the limit, then send the overflow as a new message.
      if (this.currentMessageText.length > TELEGRAM_MAX_TEXT_LEN) {
        const cutText = this.currentMessageText.slice(0, TELEGRAM_MAX_TEXT_LEN);
        const overflow = this.currentMessageText.slice(TELEGRAM_MAX_TEXT_LEN);

        // Edit existing message with truncated text (no approval — it goes on the final message)
        await deliverChannelReply(
          this.opts.callbackUrl,
          {
            chatId: this.opts.chatId,
            text: cutText,
            messageId: this.currentMessageId,
            assistantId: this.opts.assistantId,
          },
          this.opts.mintBearerToken(),
        );
        this.lastSentText = cutText;

        // Send overflow (with approval buttons if present) as a new message
        await this.sendNewMessage(overflow, approval);
        this.finishOk = true;
        return;
      }

      await deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: this.currentMessageText,
          messageId: this.currentMessageId,
          assistantId: this.opts.assistantId,
          approval,
        },
        this.opts.mintBearerToken(),
      );
      this.lastSentText = this.currentMessageText;
    }
    this.finishOk = true;
  }

  get hasDeliveredText(): boolean {
    return this.textDelivered;
  }

  /** True only when finish() completed without throwing. */
  get finishSucceeded(): boolean {
    return this.finishOk;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private onTextDelta(text: string): void {
    this.buffer += text;
    if (
      !this.currentMessageId &&
      !this.initialSendInFlight &&
      !this.textDelivered &&
      this.buffer.length + this.currentMessageText.length >= MIN_INITIAL_CHARS
    ) {
      this.sendInitialMessage();
    } else if (this.currentMessageId) {
      this.scheduleEdit();
    }
  }

  private sendInitialMessage(): void {
    this.initialSendInFlight = true;
    this.currentMessageText += this.buffer;
    this.buffer = "";

    const textSnapshot = this.currentMessageText;
    const promise = deliverChannelReply(
      this.opts.callbackUrl,
      {
        chatId: this.opts.chatId,
        text: textSnapshot,
        assistantId: this.opts.assistantId,
      },
      this.opts.mintBearerToken(),
    );
    this.initialSendPromise = promise;

    promise
      .then((result) => {
        if (result.messageId) {
          this.currentMessageId = result.messageId;
        } else {
          log.warn(
            { chatId: this.opts.chatId },
            "Initial streaming send succeeded but no messageId in response",
          );
        }
        this.textDelivered = true;
        this.lastSentText = textSnapshot;
        this.messageCount++;
        this.lastEditAt = Date.now();
        this.initialSendInFlight = false;
      })
      .catch((err) => {
        log.error(
          { err, chatId: this.opts.chatId },
          "Failed to send initial streaming message",
        );
        // Push the initial text back into the buffer so finish() can send
        // the full accumulated text as a single message
        this.buffer = this.currentMessageText + this.buffer;
        this.currentMessageText = "";
        // Fall back: clear guard so future deltas can retry
        this.initialSendInFlight = false;
        this.currentMessageId = null;
      });
  }

  private scheduleEdit(): void {
    const elapsed = Date.now() - this.lastEditAt;
    if (elapsed >= EDIT_THROTTLE_MS) {
      this.flushEdit();
    } else if (!this.editTimer) {
      const remaining = EDIT_THROTTLE_MS - elapsed;
      this.editTimer = setTimeout(() => this.flushEdit(), remaining);
    }
  }

  private flushEdit(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (this.buffer.length === 0) return;

    this.currentMessageText += this.buffer;
    this.buffer = "";

    if (this.currentMessageText.length > TELEGRAM_MAX_TEXT_LEN) {
      // Split: finalize current message with text up to the limit,
      // then send the remainder as a new message.
      const cutText = this.currentMessageText.slice(0, TELEGRAM_MAX_TEXT_LEN);
      const overflow = this.currentMessageText.slice(TELEGRAM_MAX_TEXT_LEN);

      if (this.currentMessageId) {
        deliverChannelReply(
          this.opts.callbackUrl,
          {
            chatId: this.opts.chatId,
            text: cutText,
            messageId: this.currentMessageId,
            assistantId: this.opts.assistantId,
          },
          this.opts.mintBearerToken(),
        )
          .then(() => {
            this.lastSentText = cutText;
          })
          .catch((err) => {
            log.error(
              { err, chatId: this.opts.chatId },
              "Failed to edit message at split boundary",
            );
          });
      }

      // Reset and send overflow as a new message
      this.currentMessageId = null;
      this.currentMessageText = overflow;
      const overflowSnapshot = this.currentMessageText;

      deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: overflowSnapshot,
          assistantId: this.opts.assistantId,
        },
        this.opts.mintBearerToken(),
      )
        .then((result) => {
          if (result.messageId) {
            this.currentMessageId = result.messageId;
          }
          this.lastSentText = overflowSnapshot;
          this.messageCount++;
          this.lastEditAt = Date.now();
        })
        .catch((err) => {
          log.error(
            { err, chatId: this.opts.chatId },
            "Failed to send overflow message",
          );
          this.currentMessageId = null;
        });
      return;
    }

    if (this.currentMessageId) {
      const textSnapshot = this.currentMessageText;
      deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: this.currentMessageText,
          messageId: this.currentMessageId,
          assistantId: this.opts.assistantId,
        },
        this.opts.mintBearerToken(),
      )
        .then(() => {
          this.lastSentText = textSnapshot;
        })
        .catch((err) => {
          log.error(
            { err, chatId: this.opts.chatId },
            "Failed to edit streaming message",
          );
        });
    }
    this.lastEditAt = Date.now();
  }

  private async sendNewMessage(
    text: string,
    approval?: ApprovalUIMetadata,
  ): Promise<void> {
    try {
      const result = await deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text,
          assistantId: this.opts.assistantId,
          approval,
        },
        this.opts.mintBearerToken(),
      );
      if (result.messageId) {
        this.currentMessageId = result.messageId;
      }
      this.textDelivered = true;
      this.lastSentText = text;
      this.messageCount++;
    } catch (err) {
      log.error(
        { err, chatId: this.opts.chatId },
        "Failed to send new streaming message",
      );
    }
  }
}
