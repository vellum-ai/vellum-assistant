// Contact management: list, get, and update channel status.

// === Client → Server ===

export interface ContactsRequest {
  type: "contacts";
  action: "list" | "get" | "update_channel";
  /** Contact ID (get only). */
  contactId?: string;
  /** Channel ID (update_channel only). */
  channelId?: string;
  /** New status for channel (update_channel only). */
  status?: "active" | "pending" | "revoked" | "blocked" | "unverified";
  /** New policy for channel (update_channel only). */
  policy?: "allow" | "deny" | "escalate";
  /** Reason for status change (update_channel only). */
  reason?: string;
  /** Filter by role (list only). */
  role?: "guardian" | "contact";
  /** Limit (list only). */
  limit?: number;
}

// === Server → Client ===

export interface ContactsResponse {
  type: "contacts_response";
  success: boolean;
  error?: string;
  contact?: ContactPayload;
  contacts?: ContactPayload[];
}

/** Server push — lightweight invalidation signal: the contacts table has been mutated, refetch your list. */
export interface ContactsChanged {
  type: "contacts_changed";
}

export interface ContactPayload {
  id: string;
  displayName: string;
  role: "guardian" | "contact";
  relationship?: string;
  importance: number;
  responseExpectation?: string;
  preferredTone?: string;
  contactType?: string;
  lastInteraction?: number;
  interactionCount: number;
  channels: ContactChannelPayload[];
}

export interface ContactChannelPayload {
  id: string;
  type: string;
  address: string;
  isPrimary: boolean;
  externalUserId?: string;
  status: string;
  policy: string;
  verifiedAt?: number;
  verifiedVia?: string;
  lastSeenAt?: number;
  revokedReason?: string;
  blockedReason?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ContactsClientMessages = ContactsRequest;

export type _ContactsServerMessages = ContactsResponse | ContactsChanged;
