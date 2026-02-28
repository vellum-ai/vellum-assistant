// Ingress access control: invite management, member management, and escalation decisions.

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
  /** Invitee's first name (voice invite create only). */
  friendName?: string;
  /** Guardian's first name (voice invite create only). */
  guardianName?: string;
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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _InboxClientMessages =
  | IngressInviteRequest
  | IngressMemberRequest
  | AssistantInboxEscalationRequest;

export type _InboxServerMessages =
  | IngressInviteResponse
  | IngressMemberResponse
  | AssistantInboxEscalationResponse;
