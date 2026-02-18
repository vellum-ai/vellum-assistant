/**
 * Gmail messaging provider adapter.
 *
 * Maps Gmail API responses to the platform-agnostic messaging types
 * and implements the MessagingProvider interface.
 */

import type { MessagingProvider } from '../../provider.js';
import type {
  Conversation,
  Message,
  SearchResult,
  SendResult,
  ConnectionInfo,
  ListOptions,
  HistoryOptions,
  SearchOptions,
  SendOptions,
} from '../../provider-types.js';
import type { GmailMessage, GmailMessagePart } from './types.js';
import * as gmail from './client.js';

function extractHeader(msg: GmailMessage, name: string): string {
  const lower = name.toLowerCase();
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === lower,
  )?.value ?? '';
}

function extractPlainTextBody(msg: GmailMessage): string {
  if (!msg.payload) return '';

  function walkParts(part: GmailMessagePart): string | null {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      for (const child of part.parts) {
        const result = walkParts(child);
        if (result) return result;
      }
    }
    return null;
  }

  return walkParts(msg.payload) ?? msg.snippet ?? '';
}

function mapGmailMessage(msg: GmailMessage): Message {
  const from = extractHeader(msg, 'From');
  const subject = extractHeader(msg, 'Subject');

  // Parse sender name/email from "Name <email>" format
  const emailMatch = from.match(/<([^>]+)>/);
  const senderEmail = emailMatch?.[1] ?? from;
  const senderName = emailMatch ? from.replace(/<[^>]+>/, '').trim() : from;

  return {
    id: msg.id,
    conversationId: msg.threadId,
    sender: { id: senderEmail, name: senderName || senderEmail, email: senderEmail },
    text: extractPlainTextBody(msg),
    timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
    threadId: msg.threadId,
    platform: 'gmail',
    hasAttachments: msg.payload?.parts?.some((p) => p.filename && p.filename.length > 0) ?? false,
    metadata: {
      subject,
      labelIds: msg.labelIds,
      snippet: msg.snippet,
    },
  };
}

export const gmailMessagingProvider: MessagingProvider = {
  id: 'gmail',
  displayName: 'Gmail',
  credentialService: 'integration:gmail',
  capabilities: new Set(['threads', 'labels', 'drafts_native', 'archive', 'unsubscribe']),

  async testConnection(token: string): Promise<ConnectionInfo> {
    const profile = await gmail.getProfile(token);
    return {
      connected: true,
      user: profile.emailAddress,
      platform: 'gmail',
      metadata: {
        messagesTotal: profile.messagesTotal,
        threadsTotal: profile.threadsTotal,
      },
    };
  },

  async listConversations(token: string, _options?: ListOptions): Promise<Conversation[]> {
    // Gmail "conversations" are modeled as labels with unread counts
    const labels = await gmail.listLabels(token);
    const conversations: Conversation[] = [];

    for (const label of labels) {
      // Only include meaningful labels
      if (label.type === 'system' && !['INBOX', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label.id)) {
        continue;
      }

      conversations.push({
        id: label.id,
        name: label.name,
        type: 'inbox',
        platform: 'gmail',
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

  async getHistory(token: string, conversationId: string, options?: HistoryOptions): Promise<Message[]> {
    // conversationId is a label ID — list messages in that label
    const limit = options?.limit ?? 50;
    const listResult = await gmail.listMessages(token, undefined, limit, undefined, [conversationId]);

    if (!listResult.messages?.length) return [];

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      'full',
    );

    return messages.map(mapGmailMessage);
  },

  async search(token: string, query: string, options?: SearchOptions): Promise<SearchResult> {
    const count = options?.count ?? 20;
    const listResult = await gmail.listMessages(token, query, count);

    if (!listResult.messages?.length) {
      return { total: 0, messages: [], hasMore: false };
    }

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      'full',
    );

    return {
      total: listResult.resultSizeEstimate ?? messages.length,
      messages: messages.map(mapGmailMessage),
      hasMore: !!listResult.nextPageToken,
      nextCursor: listResult.nextPageToken,
    };
  },

  async sendMessage(token: string, conversationId: string, text: string, options?: SendOptions): Promise<SendResult> {
    // conversationId is the recipient email for Gmail
    const to = conversationId;
    const subject = options?.subject ?? '';
    const msg = await gmail.sendMessage(token, to, subject, text, options?.inReplyTo, options?.threadId);
    return {
      id: msg.id,
      timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
      conversationId: msg.threadId,
    };
  },

  async getThreadReplies(token: string, _conversationId: string, threadId: string, options?: HistoryOptions): Promise<Message[]> {
    // Get all messages in a Gmail thread
    const limit = options?.limit ?? 50;
    const listResult = await gmail.listMessages(token, `thread:${threadId}`, limit);

    if (!listResult.messages?.length) return [];

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      'full',
    );

    return messages.map(mapGmailMessage);
  },

  async markRead(token: string, _conversationId: string, messageId?: string): Promise<void> {
    if (!messageId) return;
    await gmail.modifyMessage(token, messageId, { removeLabelIds: ['UNREAD'] });
  },
};
