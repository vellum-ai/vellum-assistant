// Contacts access control: invite management, member management, and escalation decisions.

// === Client → Server ===

export interface ContactsInviteRequest {
  type: "contacts_invite";
  action: "create" | "list" | "revoke" | "redeem";
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

export interface AssistantInboxEscalationRequest {
  type: "assistant_inbox_escalation";
  action: "list" | "decide";
  /** Filter by assistant ID (list only). */
  assistantId?: string;
  /** Filter by status (list only). */
  status?: string;
  /** Approval request ID (required for decide). */
  approvalRequestId?: string;
  /** Decision (required for decide). */
  decision?: "approve" | "deny";
  /** Reason for the decision (decide only). */
  reason?: string;
}

// === Server → Client ===

export interface ContactsInviteResponse {
  type: "contacts_invite_response";
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

export interface AssistantInboxEscalationResponse {
  type: "assistant_inbox_escalation_response";
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
  | ContactsInviteRequest
  | AssistantInboxEscalationRequest;

export type _InboxServerMessages =
  | ContactsInviteResponse
  | AssistantInboxEscalationResponse;
