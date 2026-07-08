// Contact management: list, get, and delete.

import type { ContactRequestEvent } from "../../api/events/contact-request.js";

// === Client → Server ===

export interface ContactsRequest {
  type: "contacts";
  action: "list" | "get" | "delete";
  /** Contact ID (get and delete). */
  contactId?: string;
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
  notes?: string;
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
  status: string;
  policy: string;
  verifiedAt?: number;
  verifiedVia?: string;
  lastSeenAt?: number;
  interactionCount?: number;
  lastInteraction?: number;
  revokedReason?: string;
  blockedReason?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ContactsClientMessages = ContactsRequest;

export type _ContactsServerMessages =
  | ContactsResponse
  | ContactsChanged
  | ContactRequestEvent;
