import { desc, eq, and, ne, or, sql } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { contacts, contactChannels } from "./schema.js";

export type Contact = typeof contacts.$inferSelect;
export type ContactChannel = typeof contactChannels.$inferSelect;

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
   * Looks up a non-revoked phone channel whose externalUserId or address
   * matches the given phone number. Used to detect callers whose number is
   * registered but not yet verified via DTMF challenge.
   */
  getContactByPhoneNumber(
    phoneNumber: string,
  ): { contact: Contact; channel: ContactChannel } | undefined {
    return this.db
      .select({ contact: contacts, channel: contactChannels })
      .from(contacts)
      .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(
        and(
          eq(contactChannels.type, "phone"),
          ne(contactChannels.status, "revoked"),
          or(
            eq(contactChannels.externalUserId, phoneNumber),
            eq(contactChannels.address, phoneNumber),
          ),
        ),
      )
      .limit(1)
      .get();
  }

  /**
   * Set lastSeenAt to now for a channel (gateway DB only).
   */
  touchChannelLastSeen(channelId: string): void {
    const now = Date.now();
    this.db
      .update(contactChannels)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(contactChannels.id, channelId))
      .run();
  }

  /**
   * Increment interaction count and set lastInteraction timestamp
   * (gateway DB only).
   */
  touchContactInteraction(channelId: string): void {
    const now = Date.now();
    this.db
      .update(contactChannels)
      .set({
        lastInteraction: now,
        interactionCount: sql`${contactChannels.interactionCount} + 1`,
        updatedAt: now,
      })
      .where(eq(contactChannels.id, channelId))
      .run();
  }
}
