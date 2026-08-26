/**
 * Channel-neutral provenance for a single transcript row.
 *
 * A conversation bound to an external channel carries two kinds of row: the
 * ones that exist in that channel (someone typed them in Slack, Telegram,
 * Discord, a phone thread, an email chain) and the ones that exist only in
 * Vellum. The sidecar draws each row exactly once, so it needs one question
 * answered per row: does this row exist in the external channel, and if so,
 * what does the channel call it?
 *
 * {@link ChannelMessageProvenance} is that answer in a vocabulary no channel
 * owns. Everything downstream of this module (the lane partition, the drawer,
 * the composer reference) reads only this shape, so adding a channel is
 * adding a reader here.
 *
 * **What limits coverage is the wire, not this module.** Provenance is read
 * from per-message envelopes serialized on `ConversationMessage`, and the web
 * projection exposes per-message provenance only through `slackMessage` (see
 * `assistant/src/api/responses/conversation-message.ts`). A channel with no
 * envelope resolves to `null` for every row, which is the honest answer: the
 * client cannot attribute those rows without guessing, so it does not, and the
 * lane partition leaves them alone. The eligibility gate in
 * `channel-sidecar-transcript.ts` deliberately does NOT consult this registry
 * for its yes/no, so a channel whose rows are unattributable still gets the
 * drawer, its identity, and its source link.
 */

import { isExternalChannelOrigin } from "@/domains/chat/utils/conversation-channel";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  ConversationChannelBinding,
  Conversation,
} from "@/types/conversation-types";
import type { ExternalSourceLink } from "@/utils/external-source-link";

/**
 * What an external channel knows about one row of a bound conversation.
 *
 * Every field beyond `channelId` and `kind` is optional because channels
 * report wildly different amounts: a chat platform has stable message ids and
 * permalinks, an email thread has a Message-ID and no thread coordinates, a
 * phone transcript may have neither. Consumers render what is present and say
 * nothing about what is not.
 */
export interface ChannelMessageProvenance {
  /**
   * Channel this row belongs to, in the daemon's `sourceChannel` /
   * `originChannel` vocabulary (see `utils/channel-presentation`).
   */
  channelId: string;
  /**
   * Whether the row is content or a non-content event the channel reported
   * against content (a reaction, a receipt). Two values rather than a free
   * string: a consumer has to render one or the other, and an unknown third
   * value has no rendering.
   */
  kind: "message" | "reaction";
  /** The channel's own id for this message, when it reports one. */
  externalMessageId?: string;
  /** The channel's own id for the thread this row sits in, when threaded. */
  externalThreadId?: string;
  /** The channel's own id for the chat, room, or channel holding the thread. */
  externalChatId?: string;
  /** Human name of that chat/room, when the channel reports one. */
  externalChatName?: string;
  /** Who sent it, already reduced to one display string. */
  senderName?: string;
  /** Deep link to this specific message in the channel. */
  sourceLink?: ExternalSourceLink;
  /**
   * Deep link to the thread holding it, kept apart from {@link sourceLink}
   * because the two answer different questions: a reference points at one
   * message, while the drawer's "open the source" action wants the thread.
   * Collapsing them would make one of the two surfaces link to the wrong
   * altitude.
   */
  threadSourceLink?: ExternalSourceLink;
  /** Present only when `kind` is `"reaction"`. */
  reaction?: {
    emoji: string;
    op: "added" | "removed";
    actorName?: string;
  };
}

/** The conversation fields provenance resolution reads. */
export type ProvenanceConversation = Pick<
  Conversation,
  "channelBinding" | "originChannel"
>;

type ChannelMessageProvenanceReader = (
  message: DisplayMessage,
  binding: ConversationChannelBinding,
) => ChannelMessageProvenance | null;

function firstNonEmpty(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Reads Slack's per-message envelope into the neutral shape.
 *
 * Registered under the channel id rather than sniffed off the row, so a row
 * carrying a Slack envelope inside a conversation bound to some other channel
 * is not attributed to Slack.
 */
const readSlackProvenance: ChannelMessageProvenanceReader = (
  message,
  binding,
) => {
  const envelope = message.slackMessage;
  if (!envelope) {
    return null;
  }
  const sender = envelope.sender;
  const provenance: ChannelMessageProvenance = {
    channelId: binding.sourceChannel,
    kind: envelope.eventKind === "reaction" ? "reaction" : "message",
    externalMessageId: envelope.channelTs,
    externalThreadId: envelope.threadTs,
    externalChatId: envelope.channelId,
    externalChatName: firstNonEmpty(
      envelope.channelName,
      binding.slackChannel?.name,
    ),
    senderName: firstNonEmpty(
      sender?.displayName,
      sender?.name,
      sender?.username,
      sender?.externalUserId,
    ),
    sourceLink: envelope.messageLink,
    threadSourceLink: envelope.threadLink,
  };
  if (envelope.reaction) {
    provenance.reaction = {
      emoji: envelope.reaction.emoji,
      op: envelope.reaction.op,
      actorName: firstNonEmpty(envelope.reaction.actorDisplayName),
    };
  }
  return provenance;
};

/**
 * Per-channel readers, one per envelope the wire carries.
 *
 * A channel absent from this map is not ineligible for the sidecar. It has no
 * per-row envelope on the wire, so its rows stay in the Vellum lane and its
 * drawer shows the channel's identity and source link instead of a message
 * list. See the module docstring.
 */
const PROVENANCE_READERS: Record<string, ChannelMessageProvenanceReader> = {
  slack: readSlackProvenance,
};

/**
 * The external channel a conversation is bound to, or `null` when it is an
 * ordinary Vellum conversation.
 *
 * Reads `channelBinding.sourceChannel` first (the daemon's authoritative
 * field) and falls back to `originChannel`, matching the daemon-side
 * precedence documented on `Conversation.originChannel`. Which origins count
 * as external is `isExternalChannelOrigin`'s call, shared with
 * `isChannelConversation`.
 */
export function getBoundChannelId(
  conversation: ProvenanceConversation | null | undefined,
): string | null {
  const origin = conversation?.channelBinding?.sourceChannel?.trim()
    ? conversation.channelBinding.sourceChannel.trim()
    : conversation?.originChannel?.trim();
  if (!origin || !isExternalChannelOrigin(origin)) {
    return null;
  }
  return origin;
}

/**
 * Resolve one row's external-channel provenance, or `null` when the client
 * cannot attribute the row to the conversation's channel.
 *
 * `null` is the conservative answer and the common one. It never means "this
 * row is definitely Vellum-only", only "nothing observable says otherwise",
 * which is why callers use it to *keep* a row in the Vellum lane rather than
 * to move it out of one.
 */
export function readChannelMessageProvenance(
  message: DisplayMessage,
  conversation: ProvenanceConversation | null | undefined,
): ChannelMessageProvenance | null {
  const binding = conversation?.channelBinding;
  const channelId = getBoundChannelId(conversation);
  if (!binding || !channelId) {
    return null;
  }
  const reader = PROVENANCE_READERS[channelId];
  if (!reader) {
    return null;
  }
  return reader(message, binding);
}

/**
 * Whether a per-row envelope exists on the wire for this channel id.
 *
 * Lets the drawer tell "this channel reports nothing per message" apart from
 * "this thread happens to be empty", which are different empty states.
 */
export function channelReportsMessageProvenance(
  channelId: string | null | undefined,
): boolean {
  return channelId != null && PROVENANCE_READERS[channelId] !== undefined;
}
