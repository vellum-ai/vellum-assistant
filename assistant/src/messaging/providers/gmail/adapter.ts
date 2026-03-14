/**
 * Gmail messaging provider adapter.
 *
 * Maps Gmail API responses to the platform-agnostic messaging types
 * and implements the MessagingProvider interface.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import type { MessagingProvider } from "../../provider.js";
import type {
  ArchiveResult,
  ConnectionInfo,
  Conversation,
  HistoryOptions,
  ListOptions,
  Message,
  SearchOptions,
  SearchResult,
  SenderDigestEntry,
  SenderDigestResult,
  SendOptions,
  SendResult,
} from "../../provider-types.js";
import * as gmail from "./client.js";
import type { GmailMessage, GmailMessagePart } from "./types.js";

function extractHeader(msg: GmailMessage, name: string): string {
  const lower = name.toLowerCase();
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ??
    ""
  );
}

function extractPlainTextBody(msg: GmailMessage): string {
  if (!msg.payload) return "";

  function walkParts(part: GmailMessagePart): string | null {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) {
      for (const child of part.parts) {
        const result = walkParts(child);
        if (result) return result;
      }
    }
    return null;
  }

  return walkParts(msg.payload) ?? msg.snippet ?? "";
}

function mapGmailMessage(msg: GmailMessage): Message {
  const from = extractHeader(msg, "From");
  const subject = extractHeader(msg, "Subject");

  // Parse sender name/email from "Name <email>" format
  const emailMatch = from.match(/<([^>]+)>/);
  const senderEmail = emailMatch?.[1] ?? from;
  const senderName = emailMatch ? from.replace(/<[^>]+>/, "").trim() : from;

  return {
    id: msg.id,
    conversationId: msg.threadId,
    sender: {
      id: senderEmail,
      name: senderName || senderEmail,
      email: senderEmail,
    },
    text: extractPlainTextBody(msg),
    timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
    threadId: msg.threadId,
    platform: "gmail",
    hasAttachments:
      msg.payload?.parts?.some((p) => p.filename && p.filename.length > 0) ??
      false,
    metadata: {
      subject,
      labelIds: msg.labelIds,
      snippet: msg.snippet,
    },
  };
}

export const gmailMessagingProvider: MessagingProvider = {
  id: "gmail",
  displayName: "Gmail",
  credentialService: "integration:google",
  capabilities: new Set([
    "threads",
    "labels",
    "drafts_native",
    "archive",
    "unsubscribe",
  ]),

  async testConnection(
    connectionOrToken: OAuthConnection | string,
  ): Promise<ConnectionInfo> {
    const connection = connectionOrToken as OAuthConnection;
    const profile = await gmail.getProfile(connection);
    return {
      connected: true,
      user: profile.emailAddress,
      platform: "gmail",
      metadata: {
        messagesTotal: profile.messagesTotal,
        threadsTotal: profile.threadsTotal,
      },
    };
  },

  async listConversations(
    connectionOrToken: OAuthConnection | string,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    const connection = connectionOrToken as OAuthConnection;
    // Gmail "conversations" are modeled as labels with unread counts
    const labels = await gmail.listLabels(connection);
    const conversations: Conversation[] = [];

    for (const label of labels) {
      // Only include meaningful labels
      if (
        label.type === "system" &&
        ![
          "INBOX",
          "STARRED",
          "IMPORTANT",
          "SENT",
          "DRAFT",
          "SPAM",
          "TRASH",
        ].includes(label.id)
      ) {
        continue;
      }

      conversations.push({
        id: label.id,
        name: label.name,
        type: "inbox",
        platform: "gmail",
        unreadCount: label.messagesUnread ?? 0,
        lastActivityAt: Date.now(), // Gmail labels don't track last activity
        metadata: {
          messagesTotal: label.messagesTotal,
          threadsTotal: label.threadsTotal,
          labelType: label.type,
        },
      });
    }

    return conversations;
  },

  async getHistory(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const connection = connectionOrToken as OAuthConnection;
    // conversationId is a label ID — list messages in that label
    const limit = options?.limit ?? 50;
    const listResult = await gmail.listMessages(
      connection,
      undefined,
      limit,
      undefined,
      [conversationId],
    );

    if (!listResult.messages?.length) return [];

    const messages = await gmail.batchGetMessages(
      connection,
      listResult.messages.map((m) => m.id),
      "full",
    );

    return messages.map(mapGmailMessage);
  },

  async search(
    connectionOrToken: OAuthConnection | string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const connection = connectionOrToken as OAuthConnection;
    const count = options?.count ?? 20;
    const listResult = await gmail.listMessages(connection, query, count);

    if (!listResult.messages?.length) {
      return { total: 0, messages: [], hasMore: false };
    }

    const messages = await gmail.batchGetMessages(
      connection,
      listResult.messages.map((m) => m.id),
      "full",
    );

    return {
      total: listResult.resultSizeEstimate ?? messages.length,
      messages: messages.map(mapGmailMessage),
      hasMore: !!listResult.nextPageToken,
      nextCursor: listResult.nextPageToken,
    };
  },

  async sendMessage(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const connection = connectionOrToken as OAuthConnection;
    // conversationId is the recipient email for Gmail
    const to = conversationId;
    const subject = options?.subject ?? "";
    const msg = await gmail.sendMessage(
      connection,
      to,
      subject,
      text,
      options?.inReplyTo,
      options?.threadId,
    );
    return {
      id: msg.id,
      timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
      conversationId: msg.threadId,
      threadId: msg.threadId,
    };
  },

  async getThreadReplies(
    connectionOrToken: OAuthConnection | string,
    _conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const connection = connectionOrToken as OAuthConnection;
    // Get all messages in a Gmail thread
    const limit = options?.limit ?? 50;
    const listResult = await gmail.listMessages(
      connection,
      `thread:${threadId}`,
      limit,
    );

    if (!listResult.messages?.length) return [];

    const messages = await gmail.batchGetMessages(
      connection,
      listResult.messages.map((m) => m.id),
      "full",
    );

    return messages.map(mapGmailMessage);
  },

  async markRead(
    connectionOrToken: OAuthConnection | string,
    _conversationId: string,
    messageId?: string,
  ): Promise<void> {
    const connection = connectionOrToken as OAuthConnection;
    if (!messageId) return;
    await gmail.modifyMessage(connection, messageId, {
      removeLabelIds: ["UNREAD"],
    });
  },

  async senderDigest(
    connectionOrToken: OAuthConnection | string,
    query: string,
    options?: { maxMessages?: number; maxSenders?: number; pageToken?: string },
  ): Promise<SenderDigestResult> {
    const connection = connectionOrToken as OAuthConnection;
    const maxMessages = Math.min(options?.maxMessages ?? 5000, 5000);
    const maxSenders = options?.maxSenders ?? 30;
    const maxIdsPerSender = 5000;

    const allMessageIds: string[] = [];
    const fetchPromises: Promise<GmailMessage[]>[] = [];
    let pageToken: string | undefined = options?.pageToken;
    let truncated = false;
    const metadataHeaders = ["From", "List-Unsubscribe"];
    const startTime = Date.now();
    const TIME_BUDGET_MS = 90_000;

    while (allMessageIds.length < maxMessages) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        truncated = true;
        break;
      }
      const pageSize = Math.min(100, maxMessages - allMessageIds.length);
      const listResp = await gmail.listMessages(
        connection,
        query,
        pageSize,
        pageToken,
      );
      const ids = (listResp.messages ?? []).map((m) => m.id);
      if (ids.length === 0) break;
      allMessageIds.push(...ids);
      fetchPromises.push(
        gmail.batchGetMessages(
          connection,
          ids,
          "metadata",
          metadataHeaders,
          "id,internalDate,payload/headers",
        ),
      );
      pageToken = listResp.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    // If we stopped because we hit the cap but there were still more pages, flag truncation
    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      return { senders: [], totalScanned: 0, queryUsed: query };
    }

    const messages = (await Promise.all(fetchPromises)).flat();

    const senderMap = new Map<
      string,
      {
        displayName: string;
        email: string;
        messageCount: number;
        hasUnsubscribe: boolean;
        newestMessageId: string;
        newestUnsubscribableMessageId: string | null;
        newestUnsubscribableEpoch: number;
        messageIds: string[];
        hasMore: boolean;
      }
    >();

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? [];
      const fromHeader =
        headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const listUnsub = headers.find(
        (h) => h.name.toLowerCase() === "list-unsubscribe",
      )?.value;

      const match = fromHeader.match(/^(.+?)\s*<([^>]+)>$/);
      const email = match
        ? match[2].toLowerCase()
        : fromHeader.trim().toLowerCase();
      const displayName = match
        ? match[1].replace(/^["']|["']$/g, "").trim()
        : "";
      if (!email) continue;

      let agg = senderMap.get(email);
      if (!agg) {
        agg = {
          displayName,
          email,
          messageCount: 0,
          hasUnsubscribe: false,
          newestMessageId: msg.id,
          newestUnsubscribableMessageId: null,
          newestUnsubscribableEpoch: 0,
          messageIds: [],
          hasMore: false,
        };
        senderMap.set(email, agg);
      }

      agg.messageCount++;
      if (listUnsub) agg.hasUnsubscribe = true;
      if (!agg.displayName && displayName) agg.displayName = displayName;

      if (agg.messageIds.length < maxIdsPerSender) {
        agg.messageIds.push(msg.id);
      } else {
        agg.hasMore = true;
      }

      const msgEpoch = msg.internalDate ? Number(msg.internalDate) : 0;
      if (listUnsub && msgEpoch >= agg.newestUnsubscribableEpoch) {
        agg.newestUnsubscribableMessageId = msg.id;
        agg.newestUnsubscribableEpoch = msgEpoch;
      }
    }

    const sorted = [...senderMap.values()]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxSenders);

    const senders: SenderDigestEntry[] = sorted.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      displayName: s.displayName || s.email.split("@")[0],
      email: s.email,
      messageCount: s.messageCount,
      hasUnsubscribe: s.hasUnsubscribe,
      newestMessageId:
        s.hasUnsubscribe && s.newestUnsubscribableMessageId
          ? s.newestUnsubscribableMessageId
          : s.newestMessageId,
      searchQuery: `from:${s.email} ${query}`,
      messageIds: s.messageIds,
      hasMore: s.hasMore,
    }));

    return {
      senders,
      totalScanned: allMessageIds.length,
      queryUsed: query,
      ...(truncated ? { truncated } : {}),
    };
  },

  async archiveByQuery(
    connectionOrToken: OAuthConnection | string,
    query: string,
  ): Promise<ArchiveResult> {
    const connection = connectionOrToken as OAuthConnection;
    const maxMessages = 5000;
    const batchModifyLimit = 1000;

    const allMessageIds: string[] = [];
    let pageToken: string | undefined;
    let truncated = false;

    while (allMessageIds.length < maxMessages) {
      const listResp = await gmail.listMessages(
        connection,
        query,
        Math.min(500, maxMessages - allMessageIds.length),
        pageToken,
      );
      const ids = (listResp.messages ?? []).map((m) => m.id);
      if (ids.length === 0) break;
      allMessageIds.push(...ids);
      pageToken = listResp.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      return { archived: 0 };
    }

    for (let i = 0; i < allMessageIds.length; i += batchModifyLimit) {
      const chunk = allMessageIds.slice(i, i + batchModifyLimit);
      await gmail.batchModifyMessages(connection, chunk, {
        removeLabelIds: ["INBOX"],
      });
    }

    return { archived: allMessageIds.length, truncated };
  },
};
