// Contacts access control: invite management and member management.

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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _InboxClientMessages = ContactsInviteRequest;

export type _InboxServerMessages = ContactsInviteResponse;
