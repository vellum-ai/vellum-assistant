/**
 * Outlook messaging provider adapter.
 *
 * Maps Microsoft Graph API responses to the platform-agnostic messaging types
 * and implements the MessagingProvider interface.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import type { MessagingProvider } from "../../provider.js";
import type {
  ConnectionInfo,
  Conversation,
  HistoryOptions,
  ListOptions,
  Message,
  SearchOptions,
  SearchResult,
  SendOptions,
  SendResult,
} from "../../provider-types.js";
import * as outlook from "./client.js";
import type { OutlookMessage } from "./types.js";

function requireConnection(
  connection: OAuthConnection | undefined,
): OAuthConnection {
  if (!connection) {
    throw new Error(
      "Outlook requires an OAuth connection — is the account connected?",
    );
  }
  return connection;
}

function mapOutlookMessage(msg: OutlookMessage): Message {
  const senderEmail = msg.from?.emailAddress?.address ?? "";
  const senderName = msg.from?.emailAddress?.name || senderEmail || "Unknown";

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    sender: {
      id: senderEmail,
      name: senderName,
      email: senderEmail,
    },
    text: msg.body.contentType === "text" ? msg.body.content : msg.bodyPreview,
    timestamp: new Date(msg.receivedDateTime).getTime(),
    threadId: msg.conversationId,
    platform: "outlook",
    hasAttachments: msg.hasAttachments ?? false,
    metadata: {
      subject: msg.subject,
      categories: msg.categories,
      isRead: msg.isRead,
      parentFolderId: msg.parentFolderId,
    },
  };
}

const MESSAGE_SELECT_FIELDS =
  "id,conversationId,subject,bodyPreview,body,from,toRecipients,receivedDateTime,isRead,hasAttachments,parentFolderId,categories,flag";

export const outlookMessagingProvider: MessagingProvider = {
  id: "outlook",
  displayName: "Outlook",
  credentialService: "outlook",
  capabilities: new Set([
    "threads",
    "folders",
    "categories",
    "drafts_native",
    "archive",
    "unsubscribe",
  ]),

  async testConnection(connection?: OAuthConnection): Promise<ConnectionInfo> {
    const conn = requireConnection(connection);
    const profile = await outlook.getProfile(conn);
    return {
      connected: true,
      user: profile.mail || profile.userPrincipalName,
      platform: "outlook",
    };
  },

  async listConversations(
    connection: OAuthConnection | undefined,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    const conn = requireConnection(connection);
    const folders = await outlook.listMailFolders(conn);
    return folders.map((folder) => ({
      id: folder.id,
      name: folder.displayName,
      type: "inbox" as const,
      platform: "outlook",
      unreadCount: folder.unreadItemCount ?? 0,
      lastActivityAt: Date.now(),
      metadata: {
        totalItemCount: folder.totalItemCount,
        childFolderCount: folder.childFolderCount,
      },
    }));
  },

  async getHistory(
    connection: OAuthConnection | undefined,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const conn = requireConnection(connection);
    const result = await outlook.listMessages(conn, {
      folderId: conversationId,
      top: options?.limit ?? 50,
      orderby: "receivedDateTime desc",
      select: MESSAGE_SELECT_FIELDS,
    });
    return (result.value ?? []).map(mapOutlookMessage);
  },

  async search(
    connection: OAuthConnection | undefined,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const conn = requireConnection(connection);
    const result = await outlook.searchMessages(conn, query, {
      top: options?.count ?? 20,
    });
    const messages = result.value ?? [];
    return {
      total: result["@odata.count"] ?? messages.length,
      messages: messages.map(mapOutlookMessage),
      hasMore: !!result["@odata.nextLink"],
    };
  },

  async sendMessage(
    connection: OAuthConnection | undefined,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const conn = requireConnection(connection);

    if (options?.inReplyTo) {
      await outlook.replyToMessage(conn, options.inReplyTo, text);
      return {
        id: "",
        timestamp: Date.now(),
        conversationId,
        threadId: options?.threadId,
      };
    }

    await outlook.sendMessage(conn, {
      message: {
        subject: options?.subject ?? "",
        body: { contentType: "text", content: text },
        toRecipients: [{ emailAddress: { address: conversationId } }],
      },
    });

    // Microsoft Graph's sendMail returns 202 with no body
    return {
      id: "",
      timestamp: Date.now(),
      conversationId,
      threadId: options?.threadId,
    };
  },

  async getThreadReplies(
    connection: OAuthConnection | undefined,
    _conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const conn = requireConnection(connection);
    const result = await outlook.listMessages(conn, {
      filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      top: options?.limit ?? 50,
      orderby: "receivedDateTime asc",
      select: MESSAGE_SELECT_FIELDS,
    });
    return (result.value ?? []).map(mapOutlookMessage);
  },

  async markRead(
    connection: OAuthConnection | undefined,
    _conversationId: string,
    messageId?: string,
  ): Promise<void> {
    const conn = requireConnection(connection);
    if (messageId) {
      await outlook.markMessageRead(conn, messageId);
    }
  },
};
