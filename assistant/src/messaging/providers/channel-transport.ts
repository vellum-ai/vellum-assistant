import type { KnownBlock } from "@slack/types";
import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
  SlackStreamOp,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../../channels/types.js";

/**
 * Per-channel state carried on the gateway callback URL (e.g. Slack `threadTs`,
 * A2A `taskId`). The dispatcher parses the URL once; each transport reads only
 * the params it needs.
 */
export interface CallbackContext {
  readonly callbackUrl: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The message an emoji reaction lands on, and what to do there. */
export interface ReactionTarget {
  readonly chatId: string;
  /** The target message, in the channel's own id space. */
  readonly messageId: string;
  readonly emoji: string;
  readonly action: "add" | "remove";
}

/**
 * A status surface update. `chatId` is the room, spelled the way every other
 * method on this interface spells it.
 */
export interface ThreadStatus {
  readonly chatId: string;
  readonly threadTs: string;
  readonly status: string;
  /** Rotating hints shown under the status while it holds. */
  readonly loadingMessages?: readonly string[];
}

/**
 * An existing message to replace in place, and what to replace it with.
 *
 * `messageId` is the target in the channel's own id space, the same way
 * `chatId` is. `blocks` and `renderRichly` are the rendering inputs the edit
 * carries, so a replacement renders the way the original did rather than
 * degrading to plain text.
 */
export interface EditTarget {
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly blocks?: readonly KnownBlock[];
  readonly renderRichly?: boolean;
}

/**
 * Direct outbound delivery for one channel, wrapping the channel's provider-API
 * send functions behind a uniform surface. Transports are registered statically
 * (delivery runs in non-daemon contexts) and dispatched by channel, resolved
 * from the gateway callback URL via `callback-routing.ts`.
 *
 * Each operation takes its own parameters and is reached through its own entry
 * point; a transport implements only the operations its channel supports, so
 * an absent method is an absent capability.
 */
export interface ChannelTransport {
  /** Canonical source channel id, e.g. `"slack"`. */
  readonly channel: ChannelId;

  /** Deliver a rendered reply (text / approval / attachments). */
  deliver(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;

  /**
   * Replace a message the assistant already sent.
   *
   * Distinct from `deliver`, which always posts something new. A channel that
   * cannot revise a sent message omits this, and a caller that needs the
   * revision to be visible has to post instead of silently doing nothing.
   *
   * An implementation must not fall back to posting when the edit fails. The
   * original would remain beside the replacement, which reads as the assistant
   * answering twice.
   */
  edit?(
    ctx: CallbackContext,
    target: EditTarget,
  ): Promise<ChannelDeliveryResult>;

  /**
   * Show that the assistant is working, in whatever form the channel has.
   *
   * Takes the place and nothing else, because that is all it needs. A channel
   * without the affordance omits the method, so implementing it is the whole
   * of declaring the capability.
   */
  typing?(ctx: CallbackContext, chatId: string): Promise<ChannelDeliveryResult>;

  /**
   * Add or remove one of the assistant's own emoji reactions on a message.
   *
   * `messageId` is the target's id in the channel's own space, the same way
   * `chatId` is: Slack spells it as a timestamp, Discord and Telegram as ids.
   * Nothing outside the channel reads it, so nothing outside needs a shared
   * spelling for it.
   */
  react?(
    ctx: CallbackContext,
    target: ReactionTarget,
  ): Promise<ChannelDeliveryResult>;

  /**
   * Set or clear the channel's own "working on it" surface.
   *
   * Distinct from `typing`: an indicator a channel refreshes on a timer versus
   * a status a channel holds until it is changed. Slack has both and uses this
   * one; a channel with only the first implements only `typing`.
   */
  setThreadStatus?(
    ctx: CallbackContext,
    status: ThreadStatus,
  ): Promise<ChannelDeliveryResult>;

  /**
   * Advance a streamed reply: open it, add to it, or close it.
   *
   * A channel that can only post a finished message omits this, and the
   * caller falls back to delivering the reply whole.
   */
  streamReply?(
    ctx: CallbackContext,
    chatId: string,
    op: SlackStreamOp,
  ): Promise<ChannelDeliveryResult>;
}
