import type { Database, Statement } from "bun:sqlite";
import { getGatewayDb } from "./connection.js";

export type Contact = {
  id: string;
  displayName: string;
  notes: string | null;
  role: string;
  principalId: string | null;
  userFile: string | null;
  contactType: string;
  createdAt: number;
  updatedAt: number;
};

export type ContactChannel = {
  id: string;
  contactId: string;
  type: string;
  address: string;
  isPrimary: boolean;
  externalUserId: string | null;
  externalChatId: string | null;
  status: string;
  policy: string;
  verifiedAt: number | null;
  verifiedVia: string | null;
  inviteId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  interactionCount: number;
  lastInteraction: number | null;
  createdAt: number;
  updatedAt: number | null;
};

type ContactRow = {
  id: string;
  display_name: string;
  notes: string | null;
  role: string;
  principal_id: string | null;
  user_file: string | null;
  contact_type: string;
  created_at: number;
  updated_at: number;
};

type ContactChannelRow = {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
  external_user_id: string | null;
  external_chat_id: string | null;
  status: string;
  policy: string;
  verified_at: number | null;
  verified_via: string | null;
  invite_id: string | null;
  revoked_reason: string | null;
  blocked_reason: string | null;
  last_seen_at: number | null;
  interaction_count: number;
  last_interaction: number | null;
  created_at: number;
  updated_at: number | null;
};

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    displayName: row.display_name,
    notes: row.notes,
    role: row.role,
    principalId: row.principal_id,
    userFile: row.user_file,
    contactType: row.contact_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toContactChannel(row: ContactChannelRow): ContactChannel {
  return {
    id: row.id,
    contactId: row.contact_id,
    type: row.type,
    address: row.address,
    isPrimary: row.is_primary === 1,
    externalUserId: row.external_user_id,
    externalChatId: row.external_chat_id,
    status: row.status,
    policy: row.policy,
    verifiedAt: row.verified_at,
    verifiedVia: row.verified_via,
    inviteId: row.invite_id,
    revokedReason: row.revoked_reason,
    blockedReason: row.blocked_reason,
    lastSeenAt: row.last_seen_at,
    interactionCount: row.interaction_count,
    lastInteraction: row.last_interaction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContactStore {
  private db: Database;

  private _getContact: Statement | null = null;
  private _listContacts: Statement | null = null;
  private _getContactByChannel: Statement | null = null;
  private _getChannelsForContact: Statement | null = null;

  constructor(db?: Database) {
    this.db = db ?? getGatewayDb();
  }

  getContact(contactId: string): Contact | null {
    const stmt =
      this._getContact ??
      (this._getContact = this.db.prepare(
        "SELECT * FROM contacts WHERE id = ?",
      ));
    const row = stmt.get(contactId) as ContactRow | null;
    return row ? toContact(row) : null;
  }

  listContacts(): Contact[] {
    const stmt =
      this._listContacts ??
      (this._listContacts = this.db.prepare(
        "SELECT * FROM contacts ORDER BY created_at DESC",
      ));
    return (stmt.all() as ContactRow[]).map(toContact);
  }

  getContactByChannel(
    channelType: string,
    externalUserId: string,
  ): Contact | null {
    const stmt =
      this._getContactByChannel ??
      (this._getContactByChannel = this.db.prepare(
        `SELECT c.* FROM contacts c
         JOIN contact_channels cc ON cc.contact_id = c.id
         WHERE cc.type = ? AND cc.external_user_id = ?
         LIMIT 1`,
      ));
    const row = stmt.get(channelType, externalUserId) as ContactRow | null;
    return row ? toContact(row) : null;
  }

  getChannelsForContact(contactId: string): ContactChannel[] {
    const stmt =
      this._getChannelsForContact ??
      (this._getChannelsForContact = this.db.prepare(
        "SELECT * FROM contact_channels WHERE contact_id = ? ORDER BY created_at ASC",
      ));
    return (stmt.all(contactId) as ContactChannelRow[]).map(toContactChannel);
  }
}
