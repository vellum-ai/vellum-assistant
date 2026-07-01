/**
 * Client-side conversation types.
 *
 * `Conversation` is the normalized shape used across the entire web app.
 * The daemon's raw response is transformed into this shape by
 * `toConversation` in `domains/conversations/conversation-transforms.ts`.
 *
 * `ConversationGroup` is a re-export of the generated SDK type for
 * user-created sidebar groups (folders).
 */

import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import type { SlackMessageLink } from "@/utils/slack-message-link";

export interface Conversation {
  conversationId: string;
  title?: string;
  createdAt?: number;
  lastMessageAt?: number;
  hasUnseenLatestAssistantMessage?: boolean;
  latestAssistantMessageAt?: number;
  lastSeenAssistantMessageAt?: number;
  archivedAt?: number;
  /**
   * Epoch-ms timestamp set when a background/scheduled conversation was
   * explicitly promoted ("surfaced") into the Recents sidebar grouping via
   * the daemon's surface API. Absent when not surfaced. Conversations are
   * never surfaced automatically.
   */
  surfacedAt?: number;
  groupId?: string;
  source?: string;
  isPinned?: boolean;
  conversationType?: string;
  scheduleJobId?: string;
  /**
   * Server-provided sort order for pinned and custom-group buckets. Set when
   * the user has drag-reordered the conversation; absent for conversations
   * that have never been reordered. Consumers (see `groupConversations`)
   * should sort pinned / custom-group buckets by this field so the user's
   * order is preserved across reloads.
   */
  displayOrder?: number;
  channelBinding?: ConversationChannelBinding;
  /**
   * Channel of origin for this conversation, e.g. `"slack"`, `"telegram"`,
   * `"phone"`, `"vellum"`, or `"notification:*"`. Sourced from the daemon's
   * `channelBinding.sourceChannel` (when present) and falling back to
   * `conversationOriginChannel`. Used by `isChannelConversation` to gate
   * the native-only edit/undo/recall path on web (and read-only rendering
   * on macOS/iOS) for externally-bound conversations.
   */
  originChannel?: string;
  /** True for optimistic stubs not yet confirmed by the server. */
  draft?: boolean;
  /** Server-seeded flag mirroring the daemon's `Conversation.isProcessing()`. Optional: pre-0.8.7 daemons and optimistic drafts omit it. */
  isProcessing?: boolean;
}

export interface ConversationChannelBinding {
  sourceChannel: string;
  externalChatId: string;
  externalThreadId?: string;
  externalChatName?: string;
  externalUserId?: string;
  displayName?: string;
  username?: string;
  slackChannel?: ConversationSlackChannel;
  slackThread?: ConversationSlackThread;
}

export interface ConversationSlackChannel {
  channelId?: string;
  name?: string;
  link?: SlackMessageLink;
}

export interface ConversationSlackThread {
  channelId: string;
  threadTs: string;
  link?: SlackMessageLink;
}

export type ConversationGroup = GroupsGetResponse["groups"][number];
