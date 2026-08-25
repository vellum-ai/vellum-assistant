import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
  StreamOp,
} from "@vellumai/gateway-client";

import type { AssistantActivityPhase } from "../../api/index.js";
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

/**
 * How busy the assistant is in one conversation, for the channel to show.
 *
 * `phase` is the daemon's own activity phase rather than a channel's word for
 * it, so every channel is told the same lifecycle and decides how to render
 * it. A channel whose indicator expires on its own re-sends while the busy
 * phases last; a channel whose indicator holds sets it once and clears it on
 * `idle`. Neither shape leaks into what the caller says.
 */
export interface ActivityTarget {
  readonly chatId: string;
  readonly phase: AssistantActivityPhase;
  /**
   * Who started the turn. Channels that attribute a session to a person read
   * it when the session is created, and ignore it afterwards.
   */
  readonly initiatorUserId?: string;
}

/**
 * Whether a phase means a turn is actually running.
 *
 * A channel with a plain busy indicator shows it for these and nothing else.
 * `awaiting_confirmation` is deliberately not one: an approval is waiting on a
 * person, and a typing bubble there promises output that is not coming.
 */
export function isBusyActivityPhase(phase: AssistantActivityPhase): boolean {
  return (
    phase === "thinking" || phase === "streaming" || phase === "tool_running"
  );
}

/**
 * An existing message to replace in place, and what to replace it with.
 *
 * `messageId` is the target in the channel's own id space, the same way
 * `chatId` is. `renderRichly` and `emphasis` are the rendering inputs the edit
 * carries, so a replacement renders the way the original did rather than
 * degrading to plain text.
 */
export interface EditTarget {
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly renderRichly?: boolean;
  /**
   * How prominent the replacement should read. Surface-agnostic, the way
   * `ApprovalActionOption.emphasis` is: each channel translates it to its own
   * token, and one with no equivalent renders plain text. `muted` marks a
   * message as settled rather than current.
   */
  readonly emphasis?: "muted";
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
   * Show how busy the assistant is, in whatever form the channel has.
   *
   * One capability rather than one per indicator shape: a self-expiring typing
   * bubble and a status that holds until cleared answer the same question, and
   * splitting them by how the channel keeps them alive forces every caller to
   * know which channel it is talking to. A channel without any such affordance
   * omits the method, so implementing it is the whole of declaring it.
   */
  setActivity?(
    ctx: CallbackContext,
    target: ActivityTarget,
  ): Promise<ChannelDeliveryResult>;

  /**
   * How often a busy indicator must be re-asserted to stay visible, for a
   * channel whose indicator expires on its own.
   *
   * Omitted by a channel whose indicator holds until it is changed, which is
   * how a caller knows to set it once rather than run a timer. Declaring the
   * cadence here keeps the caller from having to know which channel it is.
   */
  readonly activityRefreshMs?: number;

  /**
   * Advance a reply that grows while the turn runs: open it, add to it, or end
   * it.
   *
   * A channel with no primitive for this omits the method, and the caller
   * sends the finished reply instead. Omitting it is the correct answer for a
   * platform that offers nothing here rather than a gap to paper over: a
   * channel is not made to simulate streaming by rewriting a sent message,
   * which is both a worse experience and, on Telegram, discouraged by the
   * platform that does offer one.
   *
   * What the channel leaves behind when the stream ends is its own business.
   * Slack finalizes the streamed message in place; Telegram's live draft
   * expires and the reply is persisted by an ordinary send. `stop` carries the
   * complete reply so either can be true.
   */
  streamReply?(
    ctx: CallbackContext,
    chatId: string,
    op: StreamOp,
  ): Promise<ChannelDeliveryResult>;
}
