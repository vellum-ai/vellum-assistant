import type { ServerMessage } from "../daemon/ipc-protocol.js";
import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";
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
  private lastEditAt = 0; // Timestamp of last edit
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private messageCount = 0; // Total messages sent
  private finished = false;
  private textDelivered = false; // True once at least some text was sent

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
      case "tool_use_start":
        this.finalizeCurrentMessage();
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

    // Flush any remaining buffered text
    if (this.buffer.length > 0) {
      if (this.currentMessageId) {
        this.currentMessageText += this.buffer;
        this.buffer = "";
      } else {
        this.currentMessageText = this.buffer;
        this.buffer = "";
        // Send as new message
        await this.sendNewMessage(this.currentMessageText, approval);
        return;
      }
    }

    // Final edit with approval buttons if present
    if (this.currentMessageId && (this.currentMessageText || approval)) {
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
    }
  }

  get hasDeliveredText(): boolean {
    return this.textDelivered;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private onTextDelta(text: string): void {
    this.buffer += text;
    if (!this.currentMessageId && this.buffer.length >= MIN_INITIAL_CHARS) {
      this.sendInitialMessage();
    } else if (this.currentMessageId) {
      this.scheduleEdit();
    }
  }

  private sendInitialMessage(): void {
    this.currentMessageText = this.buffer;
    this.buffer = "";

    deliverChannelReply(
      this.opts.callbackUrl,
      {
        chatId: this.opts.chatId,
        text: this.currentMessageText,
        assistantId: this.opts.assistantId,
      },
      this.opts.mintBearerToken(),
    )
      .then((result) => {
        if (result.messageId) {
          this.currentMessageId = result.messageId;
        }
        this.textDelivered = true;
        this.messageCount++;
        this.lastEditAt = Date.now();
      })
      .catch((err) => {
        log.error(
          { err, chatId: this.opts.chatId },
          "Failed to send initial streaming message",
        );
        // Fall back: clear messageId so future deltas accumulate for a retry
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
        ).catch((err) => {
          log.error(
            { err, chatId: this.opts.chatId },
            "Failed to edit message at split boundary",
          );
        });
      }

      // Reset and send overflow as a new message
      this.currentMessageId = null;
      this.currentMessageText = overflow;

      deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: this.currentMessageText,
          assistantId: this.opts.assistantId,
        },
        this.opts.mintBearerToken(),
      )
        .then((result) => {
          if (result.messageId) {
            this.currentMessageId = result.messageId;
          }
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
      deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: this.currentMessageText,
          messageId: this.currentMessageId,
          assistantId: this.opts.assistantId,
        },
        this.opts.mintBearerToken(),
      ).catch((err) => {
        log.error(
          { err, chatId: this.opts.chatId },
          "Failed to edit streaming message",
        );
      });
    }
    this.lastEditAt = Date.now();
  }

  private finalizeCurrentMessage(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    // Flush any remaining buffer into the current message
    if (this.buffer.length > 0) {
      this.currentMessageText += this.buffer;
      this.buffer = "";
    }

    // Send a final edit if we have an active message
    if (this.currentMessageId && this.currentMessageText) {
      deliverChannelReply(
        this.opts.callbackUrl,
        {
          chatId: this.opts.chatId,
          text: this.currentMessageText,
          messageId: this.currentMessageId,
          assistantId: this.opts.assistantId,
        },
        this.opts.mintBearerToken(),
      ).catch((err) => {
        log.error(
          { err, chatId: this.opts.chatId },
          "Failed to finalize streaming message",
        );
      });
    }

    // Reset so the next text delta starts a new message
    this.currentMessageId = null;
    this.currentMessageText = "";
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
      this.messageCount++;
    } catch (err) {
      log.error(
        { err, chatId: this.opts.chatId },
        "Failed to send new streaming message",
      );
    }
  }
}
