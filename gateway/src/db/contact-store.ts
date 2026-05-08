import { type Database } from "bun:sqlite";

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

  /**
   * Mark a channel as verified by guardian attestation, bypassing the
   * standard challenge-code exchange. Sets `status="active"`, stamps
   * `verifiedAt=now`, and sets `verifiedVia="manual"` for audit trail.
   *
   * Atomic + idempotent. The UPDATE is gated on the row not already being
   * `(status="active" AND verified_via="manual")`, so two concurrent
   * verify requests can't both write — exactly one will see `changes=1`
   * and the other will see `changes=0`. Both still return the post-state
   * row.
   *
   * Returns the channel after the write, or `null` if no channel with
   * that id exists in the gateway DB.
   *
   * Gateway DB only — does not touch the assistant daemon.
   */
  markChannelVerified(channelId: string): {
    channel: ContactChannel;
    didWrite: boolean;
  } | null {
    const now = Date.now();
    const raw = (this.db as unknown as { $client: Database }).$client;
    const result = raw
      .prepare(
        `UPDATE contact_channels
           SET status = ?, verified_at = ?, verified_via = ?, updated_at = ?
         WHERE id = ?
           AND (status != ? OR verified_via != ? OR verified_via IS NULL)`,
      )
      .run("active", now, "manual", now, channelId, "active", "manual");

    const after = this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, channelId))
      .get();

    if (!after) return null;
    return { channel: after, didWrite: result.changes > 0 };
  }
}
