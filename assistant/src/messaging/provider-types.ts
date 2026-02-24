/** Platform-agnostic types for the messaging provider abstraction. */

export interface Conversation {
  id: string;
  name: string;
  type: 'channel' | 'dm' | 'group' | 'inbox' | 'thread';
  platform: string;
  unreadCount: number;
  lastActivityAt: number;
  memberCount?: number;
  topic?: string;
  isArchived?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MessageSender {
  id: string;
  name: string;
  email?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  text: string;
  timestamp: number;
  threadId?: string;
  replyCount?: number;
  platform: string;
  reactions?: Array<{ name: string; count: number }>;
  hasAttachments?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  total: number;
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SendResult {
  id: string;
  timestamp: number;
  conversationId: string;
}

export interface ConnectionInfo {
  connected: boolean;
  user: string;
  platform: string;
  metadata?: Record<string, unknown>;
}

export interface ListOptions {
  types?: Array<'channel' | 'dm' | 'group' | 'inbox'>;
  excludeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface HistoryOptions {
  limit?: number;
  before?: string;
  after?: string;
}

export interface SearchOptions {
  count?: number;
  cursor?: string;
}

export interface SendOptions {
  threadId?: string;
  /** For email: subject line */
  subject?: string;
  /** For email: in-reply-to message ID */
  inReplyTo?: string;
  /** Optional assistant scope for multi-assistant channels. */
  assistantId?: string;
}
