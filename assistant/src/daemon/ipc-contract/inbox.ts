// Assistant inbox: invite management, member management, inbox threads, escalations, and replies.

// === Client → Server ===

export interface IngressInviteRequest {
  type: 'ingress_invite';
  action: 'create' | 'list' | 'revoke' | 'redeem';
  /** Source channel for the invite (required for create and redeem). */
  sourceChannel?: string;
  /** Optional note describing the invite (create only). */
  note?: string;
  /** Maximum number of times the invite can be redeemed (create only). */
  maxUses?: number;
  /** Expiration time in milliseconds from now (create only). */
  expiresInMs?: number;
  /** Invite ID to revoke (revoke only). */
  inviteId?: string;
  /** Invite token to redeem (redeem only). */
  token?: string;
  /** External user ID of the redeemer (redeem only). */
  externalUserId?: string;
  /** External chat ID of the redeemer (redeem only). */
  externalChatId?: string;
  /** Filter by status (list only). */
  status?: string;
}

export interface IngressMemberRequest {
  type: 'ingress_member';
  action: 'list' | 'upsert' | 'revoke' | 'block';
  /** Assistant ID for scoping member operations (defaults to 'self'). */
  assistantId?: string;
  /** Source channel (required for upsert, optional filter for list). */
  sourceChannel?: string;
  /** External user ID (upsert only). */
  externalUserId?: string;
  /** External chat ID (upsert only). */
  externalChatId?: string;
  /** Display name (upsert only). */
  displayName?: string;
  /** Username (upsert only). */
  username?: string;
  /** Access policy (upsert only). */
  policy?: 'allow' | 'deny' | 'escalate';
  /** Member status (upsert only for setting, list only for filtering). */
  status?: 'pending' | 'active';
  /** Member ID (revoke and block only). */
  memberId?: string;
  /** Reason for revoke or block (revoke and block only). */
  reason?: string;
}

export interface AssistantInboxRequest {
  type: 'assistant_inbox';
  action: 'list_threads' | 'get_thread_messages';
  /** Filter by assistant ID (list_threads only). */
  assistantId?: string;
  /** Maximum number of results to return (list_threads and get_thread_messages). */
  limit?: number;
  /** Offset for pagination (list_threads only). */
  offset?: number;
  /** Conversation ID (required for get_thread_messages). */
  conversationId?: string;
  /** Cursor for message pagination — return messages before this ID (get_thread_messages only). */
  beforeMessageId?: string;
}

export interface AssistantInboxEscalationRequest {
  type: 'assistant_inbox_escalation';
  action: 'list' | 'decide';
  /** Filter by assistant ID (list only). */
  assistantId?: string;
  /** Filter by status (list only). */
  status?: string;
  /** Approval request ID (required for decide). */
  approvalRequestId?: string;
  /** Decision (required for decide). */
  decision?: 'approve' | 'deny';
  /** Reason for the decision (decide only). */
  reason?: string;
}

export interface AssistantInboxReplyRequest {
  type: 'assistant_inbox_reply';
  conversationId: string;
  content: string;
}

// === Server → Client ===

export interface IngressInviteResponse {
  type: 'ingress_invite_response';
  success: boolean;
  error?: string;
  /** Single invite (returned on create/revoke). Token field is only present on create. */
  invite?: {
    id: string;
    sourceChannel: string;
    token?: string;
    tokenHash: string;
    maxUses: number;
    useCount: number;
    expiresAt: number | null;
    status: string;
    note?: string;
    createdAt: number;
  };
  /** List of invites (returned on list). */
  invites?: Array<{
    id: string;
    sourceChannel: string;
    tokenHash: string;
    maxUses: number;
    useCount: number;
    expiresAt: number | null;
    status: string;
    note?: string;
    createdAt: number;
  }>;
}

export interface IngressMemberResponse {
  type: 'ingress_member_response';
  success: boolean;
  error?: string;
  /** Single member (returned on upsert/revoke/block). */
  member?: {
    id: string;
    sourceChannel: string;
    externalUserId?: string;
    externalChatId?: string;
    displayName?: string;
    username?: string;
    status: string;
    policy: string;
    lastSeenAt?: number;
    createdAt: number;
  };
  /** List of members (returned on list). */
  members?: Array<{
    id: string;
    sourceChannel: string;
    externalUserId?: string;
    externalChatId?: string;
    displayName?: string;
    username?: string;
    status: string;
    policy: string;
    lastSeenAt?: number;
    createdAt: number;
  }>;
}

export interface AssistantInboxResponse {
  type: 'assistant_inbox_response';
  success: boolean;
  error?: string;
  /** List of inbox threads (returned on list_threads). */
  threads?: Array<{
    conversationId: string;
    sourceChannel: string;
    externalChatId: string;
    externalUserId?: string;
    displayName?: string;
    username?: string;
    lastMessageAt?: number;
    unreadCount: number;
    hasPendingEscalation: boolean;
    lastInboundAt?: number;
    lastOutboundAt?: number;
  }>;
  /** List of messages (returned on get_thread_messages). */
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface AssistantInboxEscalationResponse {
  type: 'assistant_inbox_escalation_response';
  success: boolean;
  error?: string;
  /** List of escalations (returned on list). */
  escalations?: Array<{
    id: string;
    runId: string;
    conversationId: string;
    channel: string;
    requesterExternalUserId: string;
    requesterChatId: string;
    status: string;
    requestSummary?: string;
    createdAt: number;
  }>;
  /** Decision result (returned on decide). */
  decision?: {
    id: string;
    status: string;
    decidedAt: number;
  };
}

export interface AssistantInboxReplyResponse {
  type: 'assistant_inbox_reply_response';
  success: boolean;
  error?: string;
  messageId?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _InboxClientMessages =
  | IngressInviteRequest
  | IngressMemberRequest
  | AssistantInboxRequest
  | AssistantInboxEscalationRequest
  | AssistantInboxReplyRequest;

export type _InboxServerMessages =
  | IngressInviteResponse
  | IngressMemberResponse
  | AssistantInboxResponse
  | AssistantInboxEscalationResponse
  | AssistantInboxReplyResponse;
