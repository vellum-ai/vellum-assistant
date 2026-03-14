/**
 * MessagingProvider — the contract that all messaging platform adapters implement.
 *
 * Generic tools delegate to the provider, so adding a new platform is just
 * implementing one adapter file + an OAuth setup skill.
 */

import type { OAuthConnection } from "../oauth/connection.js";
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

  testConnection(
    connectionOrToken: OAuthConnection | string,
  ): Promise<ConnectionInfo>;
  listConversations(
    connectionOrToken: OAuthConnection | string,
    options?: ListOptions,
  ): Promise<Conversation[]>;
  getHistory(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  search(
    connectionOrToken: OAuthConnection | string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  sendMessage(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult>;

  // ── Optional operations (platforms implement what they support) ───

  getThreadReplies?(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  markRead?(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    messageId?: string,
  ): Promise<void>;

  /** Scan messages and group by sender for bulk cleanup (e.g. newsletter decluttering). */
  senderDigest?(
    connectionOrToken: OAuthConnection | string,
    query: string,
    options?: { maxMessages?: number; maxSenders?: number; pageToken?: string },
  ): Promise<SenderDigestResult>;
  /** Archive messages matching a search query. */
  archiveByQuery?(
    connectionOrToken: OAuthConnection | string,
    query: string,
  ): Promise<ArchiveResult>;

  /**
   * Override the default credential check used by getConnectedProviders().
   * When present, the registry calls this instead of checking for an
   * active oauth-store connection via isProviderConnected(). Useful
   * for providers that don't use OAuth (e.g. Telegram bot tokens stored
   * under a non-standard key).
   */
  isConnected?(): Promise<boolean>;

  /** Platform-specific capabilities for tool routing (e.g. 'reactions', 'threads', 'labels'). */
  capabilities: Set<string>;
}
