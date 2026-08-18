/**
 * Plugin-facing facade for running a full conversation agent-loop turn.
 *
 * This is the conversation-scoped equivalent of the daemon's
 * `processMessage` path: it persists a user message, runs the agent loop
 * (with all its machinery -- system prompt construction, conversation
 * history, tool use cycles, compaction, injections), and returns the
 * assistant's full content-block response.
 *
 * Plugins that need to drive conversation turns (e.g. meeting-bot
 * flushing a transcript excerpt) should prefer this over the stateless
 * `provider.sendMessage()` call, which has no history, no tools, and no
 * context management.
 */

import type { AssistantEvent } from "../api/index.js";
import type { ChannelId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import type { ContentBlock, MediaSource } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The chat a turn belongs to, in the channel's own terms.
 *
 * Supplied instead of a `conversationId` when the caller knows where the
 * message came from but not which conversation that is. The pair resolves to
 * the same conversation an inbound message on those coordinates would land
 * in, because it resolves through the same binding.
 *
 * That sameness is the reason this exists at all. A caller could keep its own
 * `externalChatId -> conversationId` map and pass the id, and turns would run
 * in the right place. What it could not do is make the rest of the assistant
 * agree: conversation reset is addressed by channel coordinates
 * (`handleDeleteConversation`), the deny lanes attach an access-request card
 * by them (`findInboundConversationId`), and the conversation and session
 * APIs read the channel, chat name and sender off the external binding. A
 * private map is a second name for the same conversation, and everything
 * keyed on the public one quietly misses.
 */
export interface ConversationChannelAddress {
  /** Channel the message arrived on. */
  sourceChannel: ChannelId;
  /** The chat, in the channel's own id space. */
  externalChatId: string;
  /**
   * Thread within the chat, where the channel has threads. Only Slack and
   * Telegram scope a conversation by thread; elsewhere this is carried as
   * binding metadata and does not split the conversation.
   */
  externalThreadId?: string | null;
  /** Human-readable chat name, for the conversation list. */
  externalChatName?: string | null;
  /** Who sent it, in the channel's id space. */
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

export interface RunConversationTurnOptions {
  /**
   * Conversation to run the turn in. If omitted, a new conversation is
   * created (its ID is generated with `uuidv7` and returned in the result),
   * unless {@link RunConversationTurnOptions.channel} says which chat this
   * belongs to, in which case that chat's conversation is used.
   */
  conversationId?: string;
  /**
   * The chat this turn belongs to, resolved to a conversation and bound to
   * the channel. See {@link ConversationChannelAddress}.
   *
   * Ignored when `conversationId` is given: an explicit conversation is the
   * caller saying which one, and re-resolving would overrule it. A caller
   * that wants both the binding and a conversation of its own choosing is
   * describing two different conversations, which is a bug worth surfacing
   * as one rather than silently picking a winner.
   */
  channel?: ConversationChannelAddress;
  /**
   * User message content blocks for this turn. Text blocks become the
   * user message body; image/file blocks are resolved to inline
   * attachments. Other block types (tool_use, tool_result, thinking) are
   * ignored as they are not valid user input.
   */
  content: ContentBlock[];
  /**
   * LLM call-site for inference profile resolution. Defaults to
   * `"mainAgent"` inside the agent loop when omitted.
   */
  callSite?: LLMCallSite;
  /**
   * Abort signal. When aborted, the conversation's internal abort
   * controller fires, terminating the in-flight agent loop.
   */
  signal?: AbortSignal;
  /**
   * Conversation type for newly created conversations. When omitted,
   * defaults to `"standard"` (visible in the sidebar). Set to
   * `"background"` for plugin-driven conversations that should not
   * appear in the sidebar's Recents grouping.
   *
   * Ignored when `conversationId` references an existing conversation.
   */
  conversationType?: "standard" | "background";
}

export interface RunConversationTurnResult {
  /** The assistant's full content blocks for this turn (text, tool_use, etc.). */
  content: ContentBlock[];
  /** The user message row ID assigned by the persistence layer. */
  userMessageId: string;
  /** The conversation this turn ran in. */
  conversationId: string;
  /** True when the message was queued because the conversation was busy. */
  queued?: boolean;
}

/**
 * Metadata stamped on the row that opens a plugin-driven turn. A plugin drives
 * the turn on its own schedule, so the row is machine-initiated even when it
 * lands in an ordinary standard conversation the user also types into: the
 * `automated` marker is what keeps the reply out of the `chat.assistant_reply`
 * push (see `isReplyPushIneligibleUserMessage`) and out of the memory
 * extraction pass, alongside every other machine-authored prompt. It is not an
 * echo-suppression marker, so the row still renders in the transcript.
 */
const PLUGIN_TURN_MESSAGE_METADATA = { automated: true } as const;

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text content string and attachment list from
 * {@link ContentBlock} input. Text blocks are concatenated (newline
 * separated); image and file blocks are converted to
 * {@link UserMessageAttachment} entries with their media source resolved
 * to inline base64. Other block types are ignored.
 */
function extractContentAndAttachments(
  blocks: ContentBlock[],
  resolveMedia: (
    source: MediaSource,
  ) => { data: string; media_type: string } | null,
): { text: string; attachments: UserMessageAttachment[] } {
  const textParts: string[] = [];
  const attachments: UserMessageAttachment[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image" || block.type === "file") {
      const source = block.source;
      const resolved = resolveMedia(source);
      if (resolved) {
        attachments.push({
          filename:
            source.filename ?? (block.type === "image" ? "image" : "file"),
          mimeType: resolved.media_type,
          data: resolved.data,
          ...(block.type === "file" && block.extracted_text
            ? { extractedText: block.extracted_text }
            : {}),
        });
      }
    }
  }

  return { text: textParts.join("\n"), attachments };
}

/**
 * Resolve a chat to its conversation, binding the two if they are not already.
 *
 * Two writes, the same two `handleChannelInbound` makes for an arriving
 * message, and for the same reasons. The conversation key is what makes the
 * chat resolve to this conversation next time and what conversation reset
 * addresses; the external binding is what the conversation and session APIs
 * read to show which channel a conversation came from and who is on the other
 * end. One without the other is a conversation that is half-registered, and
 * which half is missing decides which feature quietly stops working.
 *
 * Deliberately not `recordInbound`, which is the same resolution plus an
 * inbound event row. That row exists to dedup a vendor's redelivery and to
 * correlate later edits, and a caller driving a turn on its own schedule has
 * neither a vendor nor a message id to correlate. Plugin deliveries are
 * deduped upstream in the gateway before the message ever gets here.
 */
async function resolveChannelConversation(
  channel: ConversationChannelAddress,
  conversationType?: "standard" | "background",
): Promise<{ conversationId: string; created: boolean }> {
  const { findInboundConversationId, resolveInboundConversation } =
    await import("../persistence/delivery-crud.js");
  const { upsertBinding } =
    await import("../persistence/external-conversation-store.js");

  // Asked before resolving, because resolving is what creates it: once the id
  // is in hand a new conversation is indistinguishable from an existing one,
  // and the caller announces only the new. `findInboundConversationId` is the
  // read-only mirror of the resolution below, so the two agree on what
  // "already bound" means, including the Slack flat-key alias.
  const created =
    findInboundConversationId(
      channel.sourceChannel,
      channel.externalChatId,
      channel.externalThreadId,
    ) === null;

  const { conversationId } = resolveInboundConversation(
    channel.sourceChannel,
    channel.externalChatId,
    channel.externalThreadId,
    // Both apply only if this call is what mints the conversation. `origin` is
    // first-message attribution, which a chat's first turn is the only chance
    // to record.
    {
      origin: channel.sourceChannel,
      ...(conversationType ? { conversationType } : {}),
    },
  );

  // Refreshed on every turn rather than only on creation, because the sender's
  // display name and the chat's name are the vendor's to change and the
  // conversation list shows whichever we last heard. The optional fields pass
  // through as given: a caller that omits one on a later turn knows only the
  // chat coordinates this time, which `upsertBinding` reads as silence rather
  // than as the sender having no name.
  upsertBinding({
    conversationId,
    sourceChannel: channel.sourceChannel,
    externalChatId: channel.externalChatId,
    externalChatName: channel.externalChatName,
    externalThreadId: channel.externalThreadId ?? null,
    externalUserId: channel.externalUserId,
    displayName: channel.displayName,
    username: channel.username,
  });

  return { conversationId, created };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full conversation agent-loop turn: persist the user message, execute
 * the agent loop (history, tools, compaction, injections), and return the
 * assistant's full content-block response.
 *
 * When `conversationId` is omitted, a new conversation is created and its ID
 * is returned in the result.
 *
 * Events are fanned out to SSE/event-hub subscribers via `broadcastMessage`
 * (the same path the daemon's HTTP message route uses) while also being
 * collected internally so the caller receives the final response content.
 * For streaming use cases, subscribe to the conversation's events via the
 * host event hub (`assistantEventHub`).
 *
 * If the conversation is currently processing another turn, the message is
 * queued via `enqueueMessage` and the result carries `queued: true` with
 * empty content -- the queued turn will execute automatically when the
 * current turn finishes.
 */
export async function runConversationTurn(
  options: RunConversationTurnOptions,
): Promise<RunConversationTurnResult> {
  const { v7: uuidv7 } = await import("uuid");
  const { getOrCreateConversation } =
    await import("../daemon/conversation-store.js");
  const { broadcastMessage } =
    await import("../runtime/assistant-event-hub.js");
  const { resolveMediaSourceData } =
    await import("../providers/media-resolve.js");
  const { getConversation, getMessageById, getMessages } =
    await import("../persistence/conversation-crud.js");
  const { publishConversationListAndMetadataChanged } =
    await import("../runtime/sync/resource-sync-events.js");
  const { parseInterfaceId } = await import("../channels/types.js");
  const { resolveChannelCapabilities } =
    await import("../daemon/conversation-runtime-assembly.js");

  // Plugin-driven turns run as the guardian: plugins are installed by the
  // guardian, so their conversations inherit guardian trust. This lets the
  // existing non-interactive auto-approve machinery handle tool permissions
  // (the conversation is already non-interactive via `isInteractive: false`
  // below) without requiring a client to approve prompts.
  const { INTERNAL_GUARDIAN_TRUST_CONTEXT } =
    await import("../daemon/trust-context.js");

  // A channel address resolves through the same binding an inbound message
  // uses, so a turn addressed by chat lands in that chat's conversation
  // rather than a private one only this caller can find.
  const channelConversation =
    !options.conversationId && options.channel
      ? await resolveChannelConversation(
          options.channel,
          options.conversationType,
        )
      : undefined;
  const conversationId =
    options.conversationId ?? channelConversation?.conversationId ?? uuidv7();
  // A channel address reports its own novelty, since resolving it creates the
  // row: asking the DB here answers yes for a conversation minted a line ago
  // and swallows the announcement it is owed.
  const rowExisted = channelConversation
    ? !channelConversation.created
    : getConversation(conversationId) != null;
  const conversation = await getOrCreateConversation(conversationId, {
    trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    ...(options.conversationType
      ? { conversationType: options.conversationType }
      : {}),
  });

  // `getOrCreateConversation` creates the DB row (with conversationType if
  // provided) before hydrating. The normal send-message route emits a
  // "created" list invalidation so sibling clients/sidebars learn about new
  // conversations — emit it here too, but only when the row is actually new
  // so we don't spam invalidations for existing conversations.
  if (!rowExisted) {
    publishConversationListAndMetadataChanged("created", conversationId);
  }

  // Wire the external abort signal to the conversation's internal abort
  // controller so aborting the signal terminates the in-flight agent loop.
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      conversation.abortController?.abort();
    });
  }

  // Convert ContentBlock[] input to the text + attachments shape the
  // conversation's processMessage path expects.
  const { text, attachments } = extractContentAndAttachments(
    options.content,
    resolveMediaSourceData,
  );

  // The channel this turn speaks on. Runtime assembly reads the per-turn
  // context first and falls back to the conversation's `originChannel`, then
  // to `vellum`, so a turn into a conversation carrying no origin runs as
  // `vellum` without this: the wrong channel for the message row and for the
  // channel-permission cascade the tools are approved against. Null when the
  // caller names no channel, which both restores that fallback and clears any
  // context left by a previous turn.
  const turnChannelContext = options.channel
    ? {
        userMessageChannel: options.channel.sourceChannel,
        assistantMessageChannel: options.channel.sourceChannel,
      }
    : null;
  // The interface the message arrived on. `plugin` is in both the channel
  // and interface unions, matching gateway inbound. Tool gating reads this
  // as `transportInterface`; unset, the loop falls back to `web`.
  const turnInterfaceContext = options.channel
    ? (() => {
        const iface = parseInterfaceId(options.channel.sourceChannel);
        return iface
          ? {
              userMessageInterface: iface,
              assistantMessageInterface: iface,
            }
          : null;
      })()
    : null;
  if (options.channel) {
    conversation.setChannelCapabilities(
      resolveChannelCapabilities(
        options.channel.sourceChannel,
        turnInterfaceContext?.userMessageInterface,
      ),
    );
  }
  // Carried on the metadata as well, because a queued turn is drained after
  // this call returns and reads its channel from there. Without it the drain
  // inherits whichever turn was in flight, which on a shared conversation is
  // some other channel entirely.
  const metadata = {
    ...PLUGIN_TURN_MESSAGE_METADATA,
    ...(turnChannelContext ?? {}),
    ...(turnInterfaceContext ?? {}),
  };

  // Build the event emitter: fan out to SSE/event-hub subscribers via
  // broadcastMessage, then invoke the collector callback. This mirrors the
  // buildEventEmitter pattern from process-message.ts so plugin-driven
  // turns reach the same subscribers as HTTP-driven turns.
  let assistantMessageId: string | undefined;
  const onEvent = (msg: AssistantEvent): void => {
    broadcastMessage(msg, conversationId);
    if (msg.type === "message_complete" && msg.messageId) {
      assistantMessageId = msg.messageId;
    }
  };

  // When the conversation is busy, enqueue the message instead of rejecting.
  // The queue is drained automatically when the current turn finishes.
  if (conversation.isProcessing()) {
    const requestId = uuidv7();
    const enqueueResult = conversation.enqueueMessage({
      content: text,
      attachments,
      onEvent,
      requestId,
      isInteractive: false,
      metadata,
    });
    if (enqueueResult.rejected) {
      throw new Error(
        "Conversation is busy and its message queue is full. Try again later.",
      );
    }
    return {
      content: [],
      userMessageId: requestId,
      conversationId,
      queued: true,
    };
  }

  conversation.setTurnChannelContext(turnChannelContext);
  conversation.setTurnInterfaceContext(turnInterfaceContext);

  const userMessageId = await conversation.processMessage({
    content: text,
    attachments,
    onEvent,
    isInteractive: false,
    metadata,
    ...(options.callSite ? { callSite: options.callSite } : {}),
  });

  // Retrieve the assistant's full content blocks from the persisted
  // message row. The message_complete event carries the assistant
  // message ID; if it was captured, use it directly. Otherwise fall back
  // to scanning the conversation's messages for the first assistant
  // message after our user message.
  let assistantContent: ContentBlock[] = [];
  if (assistantMessageId) {
    const assistantRow = getMessageById(assistantMessageId, conversationId);
    if (assistantRow) {
      assistantContent = assistantRow.content;
    }
  }
  if (assistantContent.length === 0) {
    const allMessages = getMessages(conversationId);
    const userIdx = allMessages.findIndex((m) => m.id === userMessageId);
    if (userIdx >= 0) {
      for (let i = allMessages.length - 1; i > userIdx; i--) {
        if (allMessages[i].role === "assistant") {
          assistantContent = allMessages[i].content;
          break;
        }
      }
    }
  }

  return {
    content: assistantContent,
    userMessageId,
    conversationId,
  };
}
