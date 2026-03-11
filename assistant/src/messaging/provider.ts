/**
 * MessagingProvider — the contract that all messaging platform adapters implement.
 *
 * Generic tools delegate to the provider, so adding a new platform is just
 * implementing one adapter file + an OAuth setup skill.
 */

import type {
  ArchiveResult,
  ConnectionInfo,
  Conversation,
  HistoryOptions,
  ListOptions,
  Message,
  SearchOptions,
  SearchResult,
  SenderDigestResult,
  SendOptions,
  SendResult,
} from "./provider-types.js";

export interface MessagingProvider {
  /** Unique provider key (e.g. 'slack', 'gmail', 'discord'). */
  id: string;
  /** Human-readable name (e.g. 'Slack', 'Gmail'). */
  displayName: string;
  /** Credential service name for token-manager (e.g. 'integration:slack'). */
  credentialService: string;

  // ── Universal operations (every platform must implement) ──────────

  testConnection(token: string): Promise<ConnectionInfo>;
  listConversations(
    token: string,
    options?: ListOptions,
  ): Promise<Conversation[]>;
  getHistory(
    token: string,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  search(
    token: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  sendMessage(
    token: string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult>;

  // ── Optional operations (platforms implement what they support) ───

  getThreadReplies?(
    token: string,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  markRead?(
    token: string,
    conversationId: string,
    messageId?: string,
  ): Promise<void>;

  /** Scan messages and group by sender for bulk cleanup (e.g. newsletter decluttering). */
  senderDigest?(
    token: string,
    query: string,
    options?: { maxMessages?: number; maxSenders?: number; pageToken?: string },
  ): Promise<SenderDigestResult>;
  /** Archive messages matching a search query. */
  archiveByQuery?(token: string, query: string): Promise<ArchiveResult>;

  /**
   * Override the default credential check used by getConnectedProviders().
   * When present, the registry calls this instead of looking for
   * credential/{credentialService}/access_token. Useful for providers
   * that don't use OAuth (e.g. Telegram bot tokens stored under a
   * non-standard key).
   */
  isConnected?(): boolean;

  /** Platform-specific capabilities for tool routing (e.g. 'reactions', 'threads', 'labels'). */
  capabilities: Set<string>;
}
