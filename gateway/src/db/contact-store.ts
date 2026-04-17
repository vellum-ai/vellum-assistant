import { Database } from "bun:sqlite";
import { desc, eq, and } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { contacts, contactChannels } from "./schema.js";
import { getWorkspaceDir } from "../paths.js";
import { getLogger } from "../logger.js";

const log = getLogger("contact-store");

export type Contact = typeof contacts.$inferSelect;
export type ContactChannel = typeof contactChannels.$inferSelect;

/**
 * Extended contact shape returned by listGuardianChannels.
 * Includes fields from the assistant DB that the gateway schema
 * doesn't (yet) carry — needed by daemon callers that read
 * notes / userFile / contactType.
 */
export type GuardianChannelsResult = {
  contact: Contact & {
    notes: string | null;
    userFile: string | null;
    contactType: string;
  };
  channels: ContactChannel[];
};

export class ContactStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  getContact(contactId: string): Contact | undefined {
    return this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get();
  }

  listContacts(): Contact[] {
    return this.db
      .select()
      .from(contacts)
      .orderBy(desc(contacts.createdAt))
      .all();
  }

  getContactByChannel(
    channelType: string,
    externalUserId: string,
  ): Contact | undefined {
    return this.db
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        role: contacts.role,
        principalId: contacts.principalId,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(
        and(
          eq(contactChannels.type, channelType),
          eq(contactChannels.externalUserId, externalUserId),
        ),
      )
      .limit(1)
      .get();
  }

  getChannelsForContact(contactId: string): ContactChannel[] {
    return this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.contactId, contactId))
      .orderBy(contactChannels.createdAt)
      .all();
  }

  /**
   * List all active channels for guardian contacts.
   *
   * Tries the gateway's own contacts DB first. If empty (backfill not
   * yet run), falls back to reading the assistant's SQLite DB on the
   * shared workspace volume. Returns the guardian with the most recently
   * verified active channel, or null if no guardian exists.
   */
  listGuardianChannels(): GuardianChannelsResult | null {
    const result = this.listGuardianChannelsFromGateway();
    if (result) return result;

    return listGuardianChannelsFromAssistantDb();
  }

  private listGuardianChannelsFromGateway(): GuardianChannelsResult | null {
    const rows = this.db
      .select({
        contact: contacts,
        channel: contactChannels,
      })
      .from(contacts)
      .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
      .where(
        and(
          eq(contacts.role, "guardian"),
          eq(contactChannels.status, "active"),
        ),
      )
      .orderBy(desc(contactChannels.verifiedAt))
      .all();

    if (rows.length === 0) return null;

    const guardian = rows[0].contact;
    const channels = rows
      .filter((r) => r.contact.id === guardian.id)
      .map((r) => r.channel);

    return {
      contact: {
        ...guardian,
        // Gateway schema doesn't carry these yet — use defaults.
        // Once the backfill migration adds these columns, these
        // defaults will be replaced by real values.
        notes: null,
        userFile: null,
        contactType: "human",
      },
      channels,
    };
  }
}

// ---------------------------------------------------------------------------
// Assistant DB fallback
// ---------------------------------------------------------------------------

/**
 * Read guardian channels directly from the assistant's SQLite database
 * on the shared workspace volume. This is the fallback path used until
 * the gateway's own contacts table is populated by the backfill migration.
 */
function listGuardianChannelsFromAssistantDb(): GuardianChannelsResult | null {
  const dbPath = join(getWorkspaceDir(), "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    log.debug({ dbPath }, "Assistant DB not found — cannot fall back");
    return null;
  }

  let assistantDb: Database | null = null;
  try {
    assistantDb = new Database(dbPath, { readonly: true });
    assistantDb.exec("PRAGMA busy_timeout=3000");

    const rows = assistantDb
      .prepare(
        `SELECT
          c.id              AS c_id,
          c.display_name    AS c_display_name,
          c.role            AS c_role,
          c.principal_id    AS c_principal_id,
          c.notes           AS c_notes,
          c.user_file       AS c_user_file,
          c.contact_type    AS c_contact_type,
          c.created_at      AS c_created_at,
          c.updated_at      AS c_updated_at,
          cc.id             AS ch_id,
          cc.contact_id     AS ch_contact_id,
          cc.type           AS ch_type,
          cc.address        AS ch_address,
          cc.is_primary     AS ch_is_primary,
          cc.external_user_id  AS ch_external_user_id,
          cc.external_chat_id  AS ch_external_chat_id,
          cc.status         AS ch_status,
          cc.policy         AS ch_policy,
          cc.verified_at    AS ch_verified_at,
          cc.verified_via   AS ch_verified_via,
          cc.invite_id      AS ch_invite_id,
          cc.revoked_reason AS ch_revoked_reason,
          cc.blocked_reason AS ch_blocked_reason,
          cc.last_seen_at   AS ch_last_seen_at,
          cc.interaction_count AS ch_interaction_count,
          cc.last_interaction  AS ch_last_interaction,
          cc.created_at     AS ch_created_at,
          cc.updated_at     AS ch_updated_at
        FROM contacts c
        INNER JOIN contact_channels cc ON c.id = cc.contact_id
        WHERE c.role = 'guardian' AND cc.status = 'active'
        ORDER BY cc.verified_at DESC`,
      )
      .all() as AssistantDbRow[];

    if (rows.length === 0) return null;

    const first = rows[0];
    const guardianId = first.c_id;

    const contact = {
      id: first.c_id,
      displayName: first.c_display_name,
      role: first.c_role,
      principalId: first.c_principal_id,
      notes: first.c_notes ?? null,
      userFile: first.c_user_file ?? null,
      contactType: first.c_contact_type ?? "human",
      createdAt: first.c_created_at,
      updatedAt: first.c_updated_at,
    };

    const channels = rows
      .filter((r) => r.c_id === guardianId)
      .map((r) => ({
        id: r.ch_id,
        contactId: r.ch_contact_id,
        type: r.ch_type,
        address: r.ch_address,
        isPrimary: r.ch_is_primary === 1,
        externalUserId: r.ch_external_user_id,
        externalChatId: r.ch_external_chat_id,
        status: r.ch_status,
        policy: r.ch_policy,
        verifiedAt: r.ch_verified_at,
        verifiedVia: r.ch_verified_via,
        inviteId: r.ch_invite_id,
        revokedReason: r.ch_revoked_reason,
        blockedReason: r.ch_blocked_reason,
        lastSeenAt: r.ch_last_seen_at,
        interactionCount: r.ch_interaction_count,
        lastInteraction: r.ch_last_interaction,
        createdAt: r.ch_created_at,
        updatedAt: r.ch_updated_at,
      }));

    return { contact, channels };
  } catch (err) {
    log.warn({ err }, "Failed to read guardian channels from assistant DB");
    return null;
  } finally {
    assistantDb?.close();
  }
}

type AssistantDbRow = {
  c_id: string;
  c_display_name: string;
  c_role: string;
  c_principal_id: string | null;
  c_notes: string | null;
  c_user_file: string | null;
  c_contact_type: string | null;
  c_created_at: number;
  c_updated_at: number;
  ch_id: string;
  ch_contact_id: string;
  ch_type: string;
  ch_address: string;
  ch_is_primary: number;
  ch_external_user_id: string | null;
  ch_external_chat_id: string | null;
  ch_status: string;
  ch_policy: string;
  ch_verified_at: number | null;
  ch_verified_via: string | null;
  ch_invite_id: string | null;
  ch_revoked_reason: string | null;
  ch_blocked_reason: string | null;
  ch_last_seen_at: number | null;
  ch_interaction_count: number;
  ch_last_interaction: number | null;
  ch_created_at: number;
  ch_updated_at: number | null;
};
