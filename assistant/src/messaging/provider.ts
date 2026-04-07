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
  /** Credential service name for token-manager (e.g. 'slack'). */
  credentialService: string;

  // ── Universal operations (every platform must implement) ──────────

  testConnection(connection?: OAuthConnection): Promise<ConnectionInfo>;
  listConversations(
    connection: OAuthConnection | undefined,
    options?: ListOptions,
  ): Promise<Conversation[]>;
  getHistory(
    connection: OAuthConnection | undefined,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  search(
    connection: OAuthConnection | undefined,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  sendMessage(
    connection: OAuthConnection | undefined,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult>;

  // ── Optional operations (platforms implement what they support) ───

  getThreadReplies?(
    connection: OAuthConnection | undefined,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]>;
  markRead?(
    connection: OAuthConnection | undefined,
    conversationId: string,
    messageId?: string,
  ): Promise<void>;

  /** Scan messages and group by sender for bulk cleanup (e.g. newsletter decluttering). */
  senderDigest?(
    connection: OAuthConnection | undefined,
    query: string,
    options?: { maxMessages?: number; maxSenders?: number; pageToken?: string },
  ): Promise<SenderDigestResult>;
  /** Archive messages matching a search query. */
  archiveByQuery?(
    connection: OAuthConnection | undefined,
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

  /**
   * Custom credential resolution for providers with non-standard credential
   * paths (e.g. Slack Socket Mode stores tokens under "slack_channel" rather
   * than the OAuth provider key). When present, getProviderConnection() calls
   * this instead of resolveOAuthConnection(), giving the provider full control
   * over credential lookup including fallback strategies.
   *
   * Returns an OAuthConnection if the provider uses OAuth, or undefined if
   * the provider manages credentials internally (e.g. raw bot tokens).
   */
  resolveConnection?(account?: string): Promise<OAuthConnection | undefined>;

  /** Platform-specific capabilities for tool routing (e.g. 'reactions', 'threads', 'labels'). */
  capabilities: Set<string>;
}
