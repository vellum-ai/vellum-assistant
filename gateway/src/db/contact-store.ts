import { type Database } from "bun:sqlite";

import { and, desc, eq, ne, or, sql } from "drizzle-orm";

import { assistantDbRun } from "./assistant-db-proxy.js";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { contacts, contactChannels } from "./schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("contact-store");

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
   * Gateway DB (source of truth) + best-effort assistant DB dual-write.
   */
  async markChannelVerified(channelId: string): Promise<{
    channel: ContactChannel;
    didWrite: boolean;
  } | null> {
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
    const didWrite = result.changes > 0;

    // Mirror the write to the assistant DB only when the gateway actually
    // wrote (best-effort dual-write). Skipping the no-op case prevents
    // spurious verified_at/updated_at drift in the assistant DB on idempotent
    // calls. The gateway DB remains source of truth.
    if (didWrite) {
      try {
        await assistantDbRun(
          `UPDATE contact_channels
             SET status = 'active', verified_at = ?, verified_via = 'manual', updated_at = ?
           WHERE id = ?`,
          [now, now, channelId],
        );
      } catch (err) {
        log.warn(
          { channelId, err },
          "markChannelVerified: assistant DB dual-write failed (best-effort)",
        );
      }
    }

    return { channel: after, didWrite };
  }

  // ---------------------------------------------------------------------------
  // Upsert (gateway DB — auth/authz fields only)
  // ---------------------------------------------------------------------------

  /**
   * Upsert a contact + channels in the gateway DB.
   *
   * Resolution order (mirrors the assistant's upsertContact):
   *  1. Match by `params.id` if provided.
   *  2. Match by (type, address) on any provided channel.
   *  3. Create a new contact with a generated id.
   *
   * Channel sync follows the same no-reassignment path: existing channels
   * on the same contact are updated; conflicting channels on a different
   * contact are skipped.
   *
   * Only writes gateway-owned columns (id, displayName, role, principalId).
   * The assistant-only columns (notes, userFile, contactType) are handled
   * separately via assistantDbRun dual-write in the caller.
   */
  upsertContact(params: {
    id?: string;
    displayName: string;
    role?: string;
    principalId?: string | null;
    channels?: Array<{
      type: string;
      address: string;
      isPrimary?: boolean;
      externalUserId?: string | null;
      externalChatId?: string | null;
      status?: string;
      policy?: string;
      verifiedAt?: number | null;
      verifiedVia?: string | null;
      inviteId?: string | null;
      revokedReason?: string | null;
      blockedReason?: string | null;
    }>;
  }): { contact: Contact; channels: ContactChannel[]; created: boolean } {
    const now = Date.now();
    let contactId = params.id;
    let created = false;

    // ── 1. Look up by id ──────────────────────────────────────────────
    if (contactId) {
      const existing = this.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .get();

      if (existing) {
        this.db
          .update(contacts)
          .set({
            displayName: params.displayName,
            role: params.role ?? existing.role,
            principalId:
              params.principalId !== undefined
                ? params.principalId
                : existing.principalId,
            updatedAt: now,
          })
          .where(eq(contacts.id, contactId))
          .run();
      } else {
        this.db
          .insert(contacts)
          .values({
            id: contactId,
            displayName: params.displayName,
            role: params.role ?? "contact",
            principalId: params.principalId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        created = true;
      }
    }

    // ── 2. Look up by channel address ─────────────────────────────────
    if (!contactId && params.channels?.length) {
      for (const ch of params.channels) {
        const address = ch.address.toLowerCase();
        const match = this.db
          .select({ contactId: contactChannels.contactId })
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.type, ch.type),
              eq(contactChannels.address, address),
            ),
          )
          .get();

        if (match) {
          contactId = match.contactId;
          this.db
            .update(contacts)
            .set({
              displayName: params.displayName,
              role: params.role ?? "contact",
              principalId: params.principalId ?? null,
              updatedAt: now,
            })
            .where(eq(contacts.id, contactId))
            .run();
          break;
        }
      }
    }

    // ── 3. Create new ─────────────────────────────────────────────────
    if (!contactId) {
      contactId = crypto.randomUUID();
      this.db
        .insert(contacts)
        .values({
          id: contactId,
          displayName: params.displayName,
          role: params.role ?? "contact",
          principalId: params.principalId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created = true;
    }

    // ── 4. Sync channels ──────────────────────────────────────────────
    if (params.channels?.length) {
      this.#syncChannels(contactId, params.channels, now);
    }

    const contact = this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get()!;
    const channels = this.getChannelsForContact(contactId);
    return { contact, channels, created };
  }

  #syncChannels(
    contactId: string,
    channels: NonNullable<Parameters<ContactStore["upsertContact"]>[0]["channels"]>,
    now: number,
  ): void {
    for (const ch of channels) {
      const address = ch.address.toLowerCase();

      const existing = this.db
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, contactId),
            eq(contactChannels.type, ch.type),
            eq(contactChannels.address, address),
          ),
        )
        .get();

      if (existing) {
        const isBlocked = existing.status === "blocked";
        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (ch.isPrimary !== undefined) updateSet.isPrimary = ch.isPrimary;
        if (ch.externalUserId !== undefined)
          updateSet.externalUserId = ch.externalUserId;
        if (ch.externalChatId !== undefined)
          updateSet.externalChatId = ch.externalChatId;
        if (!isBlocked) {
          if (ch.status !== undefined) updateSet.status = ch.status;
          if (ch.policy !== undefined) updateSet.policy = ch.policy;
          if (ch.revokedReason !== undefined)
            updateSet.revokedReason = ch.revokedReason;
          if (ch.blockedReason !== undefined)
            updateSet.blockedReason = ch.blockedReason;
        }
        if (ch.verifiedAt !== undefined) updateSet.verifiedAt = ch.verifiedAt;
        if (ch.verifiedVia !== undefined) updateSet.verifiedVia = ch.verifiedVia;
        if (ch.inviteId !== undefined) updateSet.inviteId = ch.inviteId;
        this.db
          .update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existing.id))
          .run();
        continue;
      }

      // Cross-contact conflict check — skip to avoid unique-address violations
      const conflict = this.db
        .select({ id: contactChannels.id })
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.type, ch.type),
            eq(contactChannels.address, address),
          ),
        )
        .get();
      if (conflict) continue;

      // New channel
      this.db
        .insert(contactChannels)
        .values({
          id: crypto.randomUUID(),
          contactId,
          type: ch.type,
          address,
          isPrimary: ch.isPrimary ?? false,
          externalUserId: ch.externalUserId ?? null,
          externalChatId: ch.externalChatId ?? null,
          status: (ch.status as ContactChannel["status"]) ?? "unverified",
          policy: (ch.policy as ContactChannel["policy"]) ?? "allow",
          verifiedAt: ch.verifiedAt ?? null,
          verifiedVia: ch.verifiedVia ?? null,
          inviteId: ch.inviteId ?? null,
          revokedReason: ch.revokedReason ?? null,
          blockedReason: ch.blockedReason ?? null,
          interactionCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }
}
