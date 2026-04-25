import { desc, eq, and } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { contacts, contactChannels } from "./schema.js";

export type Contact = typeof contacts.$inferSelect;
export type ContactChannel = typeof contactChannels.$inferSelect;

/** Ingress-relevant contact fields (gateway-owned subset). */
export interface UpsertContactParams {
  id: string;
  displayName: string;
  role: string;
  principalId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Full channel row for upsert. */
export interface UpsertContactChannelParams {
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
}

export class ContactStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  // ── Reads ────────────────────────────────────────────────────────────

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

  // ── Writes ───────────────────────────────────────────────────────────

  /**
   * Upsert a contact with its channels in a single transaction.
   * On conflict (same ID), updates all mutable fields.
   * Channels are upserted individually — existing channels are updated,
   * new ones are inserted.
   */
  upsertContactWithChannels(
    contact: UpsertContactParams,
    channels: UpsertContactChannelParams[],
  ): void {
    this.db.transaction((tx) => {
      tx.insert(contacts)
        .values({
          id: contact.id,
          displayName: contact.displayName,
          role: contact.role,
          principalId: contact.principalId,
          createdAt: contact.createdAt,
          updatedAt: contact.updatedAt,
        })
        .onConflictDoUpdate({
          target: contacts.id,
          set: {
            displayName: contact.displayName,
            role: contact.role,
            principalId: contact.principalId,
            updatedAt: contact.updatedAt,
          },
        })
        .run();

      for (const ch of channels) {
        tx.insert(contactChannels)
          .values({
            id: ch.id,
            contactId: ch.contactId,
            type: ch.type,
            address: ch.address,
            isPrimary: ch.isPrimary,
            externalUserId: ch.externalUserId,
            externalChatId: ch.externalChatId,
            status: ch.status,
            policy: ch.policy,
            verifiedAt: ch.verifiedAt,
            verifiedVia: ch.verifiedVia,
            inviteId: ch.inviteId,
            revokedReason: ch.revokedReason,
            blockedReason: ch.blockedReason,
            lastSeenAt: ch.lastSeenAt,
            interactionCount: ch.interactionCount,
            lastInteraction: ch.lastInteraction,
            createdAt: ch.createdAt,
            updatedAt: ch.updatedAt,
          })
          .onConflictDoUpdate({
            target: contactChannels.id,
            set: {
              contactId: ch.contactId,
              type: ch.type,
              address: ch.address,
              isPrimary: ch.isPrimary,
              externalUserId: ch.externalUserId,
              externalChatId: ch.externalChatId,
              status: ch.status,
              policy: ch.policy,
              verifiedAt: ch.verifiedAt,
              verifiedVia: ch.verifiedVia,
              inviteId: ch.inviteId,
              revokedReason: ch.revokedReason,
              blockedReason: ch.blockedReason,
              lastSeenAt: ch.lastSeenAt,
              interactionCount: ch.interactionCount,
              lastInteraction: ch.lastInteraction,
              updatedAt: ch.updatedAt,
            },
          })
          .run();
      }
    });
  }
}
