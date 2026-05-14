import { type Database } from "bun:sqlite";

import { and, desc, eq, ne, or, sql } from "drizzle-orm";

import {
  type SqliteValue,
  assistantDbQuery,
  assistantDbRun,
} from "./assistant-db-proxy.js";
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
   * Migration-window backfill: ensure a channel exists in the gateway DB
   * by mirroring it (plus its parent contact) from the assistant DB when
   * absent. Returns `true` when the channel is present in the gateway DB
   * after the call (pre-existing or just mirrored), `false` when neither
   * side has it.
   *
   * Why this exists: during the gateway-security-migration the assistant
   * DB is the present-day source of truth for contacts. The gateway DB is
   * back-filled lazily as contacts are touched. Without this hop, any
   * channel created before the dual-write was wired would 404 from
   * gateway-native channel mutators even though the user sees it in the
   * assistant UI.
   *
   * Idempotent — both INSERTs are `INSERT ... ON CONFLICT DO NOTHING`, so
   * concurrent mirrors converge without conflict.
   */
  private async mirrorChannelFromAssistantIfMissing(
    channelId: string,
  ): Promise<boolean> {
    const existing = this.db
      .select({ id: contactChannels.id })
      .from(contactChannels)
      .where(eq(contactChannels.id, channelId))
      .get();
    if (existing) return true;

    type ChannelRow = {
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
    const channelRows = await assistantDbQuery<ChannelRow>(
      `SELECT id, contact_id, type, address, is_primary, external_user_id,
              external_chat_id, status, policy, verified_at, verified_via,
              invite_id, revoked_reason, blocked_reason, last_seen_at,
              interaction_count, last_interaction, created_at, updated_at
         FROM contact_channels WHERE id = ?`,
      [channelId],
    );
    if (channelRows.length === 0) return false;
    const channelRow = channelRows[0]!;

    type ContactRow = {
      id: string;
      display_name: string;
      role: string | null;
      principal_id: string | null;
      created_at: number;
      updated_at: number | null;
    };
    const contactRows = await assistantDbQuery<ContactRow>(
      `SELECT id, display_name, role, principal_id, created_at, updated_at
         FROM contacts WHERE id = ?`,
      [channelRow.contact_id],
    );
    if (contactRows.length === 0) {
      log.warn(
        { channelId, contactId: channelRow.contact_id },
        "mirrorChannelFromAssistantIfMissing: assistant channel references missing contact — refusing to mirror",
      );
      return false;
    }
    const contactRow = contactRows[0]!;

    // Parent contact first so the channel's FK lands. Both INSERTs are
    // conflict-tolerant: contact may already exist (e.g. a sibling channel
    // mirrored earlier), and a concurrent mirror of this channel by another
    // request must not collide.
    this.db
      .insert(contacts)
      .values({
        id: contactRow.id,
        displayName: contactRow.display_name,
        role: contactRow.role ?? "contact",
        principalId: contactRow.principal_id,
        createdAt: contactRow.created_at,
        updatedAt: contactRow.updated_at ?? contactRow.created_at,
      })
      .onConflictDoNothing()
      .run();

    this.db
      .insert(contactChannels)
      .values({
        id: channelRow.id,
        contactId: channelRow.contact_id,
        type: channelRow.type,
        address: channelRow.address,
        isPrimary: Boolean(channelRow.is_primary),
        externalUserId: channelRow.external_user_id,
        externalChatId: channelRow.external_chat_id,
        status: channelRow.status,
        policy: channelRow.policy,
        verifiedAt: channelRow.verified_at,
        verifiedVia: channelRow.verified_via,
        inviteId: channelRow.invite_id,
        revokedReason: channelRow.revoked_reason,
        blockedReason: channelRow.blocked_reason,
        lastSeenAt: channelRow.last_seen_at,
        interactionCount: channelRow.interaction_count,
        lastInteraction: channelRow.last_interaction,
        createdAt: channelRow.created_at,
        updatedAt: channelRow.updated_at,
      })
      .onConflictDoNothing()
      .run();

    log.info(
      { channelId, contactId: channelRow.contact_id },
      "mirrorChannelFromAssistantIfMissing: mirrored channel + parent contact from assistant DB",
    );
    return true;
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
   * Returns the channel after the write, or `null` if neither the gateway
   * DB nor the assistant DB has a channel with that id.
   *
   * Gateway DB (source of truth) + best-effort assistant DB dual-write.
   * When the channel is missing on the gateway but present on the assistant,
   * it (plus its parent contact) is mirrored into the gateway first.
   */
  async markChannelVerified(channelId: string): Promise<{
    channel: ContactChannel;
    didWrite: boolean;
  } | null> {
    // Migration-window backfill: if the gateway DB has never seen this
    // channel, but the assistant DB has it, mirror channel + parent contact
    // into the gateway DB before attempting the verify write. Without this,
    // any contact channel created before the dual-write was wired would
    // 404 here even though the user can see the channel in their UI.
    const mirrored = await this.mirrorChannelFromAssistantIfMissing(channelId);
    if (!mirrored) return null;

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
  // Upsert (gateway DB + assistant DB dual-write)
  // ---------------------------------------------------------------------------

  /**
   * Upsert a contact + channels in the gateway DB and dual-write the same
   * change to the assistant DB (best-effort).
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
   * The gateway DB is the source of truth for auth/authz fields (id,
   * displayName, role, principalId). The assistant DB receives a mirrored
   * write for the assistant-only columns (notes, userFile, contactType,
   * assistantContactMetadata) plus a copy of the channel rows. The
   * assistant-DB dual-write is best-effort: failures are logged but do not
   * fail the call. The returned `contact` shape is read back from the
   * assistant DB when available, falling back to a synthetic shape built
   * from the gateway row on any read-back failure.
   *
   * SECURITY: `role` and `principalId` are intentionally NOT accepted as
   * inputs. They are auth/authz fields owned by guardian-bootstrap (raw
   * SQL writes) — accepting them here would let any caller of POST
   * /v1/contacts rebind the guardian. On update, existing role/principalId
   * are preserved. On create, role defaults to "contact" and principalId
   * to null.
   */
  async upsertContact(params: {
    id?: string;
    displayName: string;
    notes?: string | null;
    contactType?: string;
    assistantMetadata?: {
      species: string;
      metadata?: Record<string, unknown> | null;
    };
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
  }): Promise<{ contact: ContactWithChannels; created: boolean }> {
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
        // Preserve existing role/principalId — they're never overwritten by
        // this code path. Guardian binding is owned by guardian-bootstrap.
        this.db
          .update(contacts)
          .set({
            displayName: params.displayName,
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
            role: "contact",
            principalId: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        created = true;
      }
    }

    // ── 2. Look up by channel address ─────────────────────────────────
    // Channel-match UPDATE preserves existing role/principalId — those
    // fields are not part of this method's input surface.
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
          role: "contact",
          principalId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created = true;
    }

    // ── 4. Sync channels (gateway DB) ─────────────────────────────────
    if (params.channels?.length) {
      this.syncChannels(contactId, params.channels, now);
    }

    // ── 5. Dual-write to assistant DB (best-effort) ───────────────────
    try {
      await this.dualWriteContactToAssistantDb(contactId, params, now, created);
    } catch (err) {
      log.warn(
        { contactId, err },
        "upsertContact: assistant DB dual-write failed (best-effort)",
      );
    }

    // ── 6. Read back full contact shape (best-effort) ─────────────────
    const fullContact = await this.readAssistantContact(contactId).catch(
      (err) => {
        log.warn(
          { contactId, err },
          "upsertContact: assistant DB read-back failed; returning gateway fallback",
        );
        return null;
      },
    );

    if (fullContact) {
      return { contact: fullContact, created };
    }

    // Fallback: synthesize from gateway row + provided params.
    const gatewayRow = this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get()!;
    return {
      contact: {
        id: gatewayRow.id,
        displayName: gatewayRow.displayName,
        role: gatewayRow.role,
        principalId: gatewayRow.principalId,
        notes: params.notes ?? null,
        contactType: params.contactType ?? "human",
        userFile: null,
        createdAt: gatewayRow.createdAt,
        updatedAt: gatewayRow.updatedAt,
        interactionCount: 0,
        lastInteraction: null,
        channels: [],
      },
      created,
    };
  }

  // ---------------------------------------------------------------------------
  // Channel sync (gateway DB)
  // ---------------------------------------------------------------------------

  private syncChannels(
    contactId: string,
    channels: NonNullable<
      Parameters<ContactStore["upsertContact"]>[0]["channels"]
    >,
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

  // ---------------------------------------------------------------------------
  // Assistant DB dual-write
  // ---------------------------------------------------------------------------

  /**
   * Mirror the contact + channels write to the assistant DB.
   *
   * - For an existing contact, build a dynamic SET clause that only touches
   *   fields the caller explicitly provided. Without this guard, a partial
   *   upsert (e.g. `{displayName: "X"}`) would clobber `notes`, `role`,
   *   `contact_type`, and `principal_id` to default values — silently losing
   *   data that the assistant DB may have but the gateway DB doesn't carry.
   *
   * - For a new contact, INSERT the full row with a freshly resolved
   *   `user_file` slug.
   *
   * - For each channel: UPDATE if a row already exists on the same contact;
   *   otherwise INSERT (skipping addresses claimed by a different contact).
   */
  private async dualWriteContactToAssistantDb(
    contactId: string,
    params: Parameters<ContactStore["upsertContact"]>[0],
    now: number,
    isNew: boolean,
  ): Promise<void> {
    const existing = await assistantDbQuery<{ userFile: string | null }>(
      "SELECT user_file AS userFile FROM contacts WHERE id = ?",
      [contactId],
    );

    if (existing.length) {
      // Dynamic SET clause: only touch fields the caller actually provided.
      // role / principal_id are intentionally never updated from this path —
      // they're not in the params surface and the assistant DB already holds
      // the values written by guardian-bootstrap.
      const setParts: string[] = ["display_name = ?", "updated_at = ?"];
      const setParams: SqliteValue[] = [params.displayName, now];

      if (params.notes !== undefined) {
        setParts.push("notes = ?");
        setParams.push(params.notes ?? null);
      }
      if (params.contactType !== undefined) {
        setParts.push("contact_type = ?");
        setParams.push(params.contactType);
      }
      setParams.push(contactId);

      await assistantDbRun(
        `UPDATE contacts SET ${setParts.join(", ")} WHERE id = ?`,
        setParams,
      );
    } else {
      const userFile = await this.resolveAssistantUserFileSlug(
        params.displayName,
        null,
      );
      await assistantDbRun(
        `INSERT INTO contacts
           (id, display_name, notes, role, contact_type, principal_id,
            user_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          params.displayName,
          params.notes ?? null,
          "contact",
          params.contactType ?? "human",
          null,
          userFile,
          now,
          now,
        ],
      );
    }

    // Assistant contact metadata (assistant-type contacts only).
    if (params.contactType === "assistant" && params.assistantMetadata) {
      await assistantDbRun(
        `INSERT INTO assistant_contact_metadata (contact_id, species, metadata)
         VALUES (?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
           species  = excluded.species,
           metadata = excluded.metadata`,
        [
          contactId,
          params.assistantMetadata.species,
          params.assistantMetadata.metadata != null
            ? JSON.stringify(params.assistantMetadata.metadata)
            : null,
        ],
      );
    }

    // Sync channels to the assistant DB.
    for (const ch of params.channels ?? []) {
      const address = ch.address.toLowerCase();

      const existingCh = await assistantDbQuery<{ id: string; status: string }>(
        "SELECT id, status FROM contact_channels WHERE contact_id = ? AND type = ? AND address = ?",
        [contactId, ch.type, address],
      );

      if (existingCh.length) {
        const isBlocked = existingCh[0].status === "blocked";
        const setParts: string[] = [
          "external_user_id = ?",
          "external_chat_id = ?",
          "updated_at = ?",
        ];
        const setParams: SqliteValue[] = [
          ch.externalUserId ?? null,
          ch.externalChatId ?? null,
          now,
        ];
        if (!isBlocked) {
          if (ch.status !== undefined) {
            setParts.push("status = ?");
            setParams.push(ch.status);
          }
          if (ch.policy !== undefined) {
            setParts.push("policy = ?");
            setParams.push(ch.policy);
          }
        }
        setParams.push(existingCh[0].id);
        await assistantDbRun(
          `UPDATE contact_channels SET ${setParts.join(", ")} WHERE id = ?`,
          setParams,
        );
      } else {
        // Skip if an address conflict exists on a different contact.
        const conflict = await assistantDbQuery<{ id: string }>(
          "SELECT id FROM contact_channels WHERE type = ? AND address = ?",
          [ch.type, address],
        );
        if (conflict.length) continue;

        await assistantDbRun(
          `INSERT INTO contact_channels
             (id, contact_id, type, address, is_primary,
              external_user_id, external_chat_id,
              status, policy, interaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            crypto.randomUUID(),
            contactId,
            ch.type,
            address,
            ch.isPrimary ? 1 : 0,
            ch.externalUserId ?? null,
            ch.externalChatId ?? null,
            ch.status ?? "unverified",
            ch.policy ?? "allow",
            now,
            now,
          ],
        );
      }
    }

    // Touch the variable so the parameter isn't flagged unused.
    void isNew;
  }

  /**
   * Compute a unique `user_file` slug for a new contact in the assistant DB.
   *
   * Mirrors the assistant's slug logic in two ways:
   *  1. Sibling contacts that share a `principalId` reuse the existing
   *     `userFile` of any sibling — every channel for one principal must
   *     resolve to the same persona + journal slug.
   *  2. Otherwise: lowercase kebab from `displayName`, collision-suffixed
   *     with `-2`, `-3`, etc.
   */
  private async resolveAssistantUserFileSlug(
    displayName: string,
    principalId: string | null,
  ): Promise<string> {
    if (principalId) {
      const sibling = await assistantDbQuery<{ userFile: string | null }>(
        `SELECT user_file AS userFile
           FROM contacts
          WHERE principal_id = ?
            AND user_file IS NOT NULL
          LIMIT 1`,
        [principalId],
      );
      if (sibling.length && sibling[0].userFile) {
        return sibling[0].userFile;
      }
    }

    const slug =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100) || "user";

    const rows = await assistantDbQuery<{ userFile: string | null }>(
      "SELECT user_file AS userFile FROM contacts WHERE user_file LIKE ?",
      [`${slug}%`],
    );
    const taken = new Set(
      rows.map((r) => r.userFile?.toLowerCase()).filter(Boolean),
    );

    const base = `${slug}.md`;
    if (!taken.has(base)) return base;

    for (let i = 2; i <= 100; i++) {
      const candidate = `${slug}-${i}.md`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${slug}-${crypto.randomUUID().slice(0, 8)}.md`;
  }

  /**
   * Read a contact + channels from the assistant DB and return the full
   * `ContactWithChannels` shape used in API responses. Returns null if the
   * contact is not found in the assistant DB.
   */
  private async readAssistantContact(
    contactId: string,
  ): Promise<ContactWithChannels | null> {
    const rows = await assistantDbQuery<AssistantContactRow>(
      `SELECT c.id,
              c.display_name      AS displayName,
              c.notes,
              c.role,
              c.contact_type      AS contactType,
              c.principal_id      AS principalId,
              c.user_file         AS userFile,
              c.created_at        AS createdAt,
              c.updated_at        AS updatedAt,
              cc.id               AS channelId,
              cc.type             AS channelType,
              cc.address,
              cc.is_primary       AS isPrimary,
              cc.external_user_id AS externalUserId,
              cc.external_chat_id AS externalChatId,
              cc.status           AS channelStatus,
              cc.policy           AS channelPolicy,
              cc.verified_at      AS verifiedAt,
              cc.verified_via     AS verifiedVia,
              cc.invite_id        AS inviteId,
              cc.revoked_reason   AS revokedReason,
              cc.blocked_reason   AS blockedReason,
              cc.last_seen_at     AS lastSeenAt,
              cc.interaction_count AS interactionCount,
              cc.last_interaction  AS lastInteraction,
              cc.created_at       AS channelCreatedAt,
              cc.updated_at       AS channelUpdatedAt
         FROM contacts c
         LEFT JOIN contact_channels cc ON cc.contact_id = c.id
        WHERE c.id = ?
        ORDER BY cc.is_primary DESC, cc.created_at ASC`,
      [contactId],
    );

    if (!rows.length) return null;

    const first = rows[0];
    const channels = rows
      .filter((r) => r.channelId !== null)
      .map((r) => ({
        id: r.channelId!,
        contactId,
        type: r.channelType!,
        address: r.address!,
        isPrimary: Boolean(r.isPrimary),
        externalUserId: r.externalUserId,
        externalChatId: r.externalChatId,
        status: r.channelStatus,
        policy: r.channelPolicy,
        verifiedAt: r.verifiedAt,
        verifiedVia: r.verifiedVia,
        inviteId: r.inviteId,
        revokedReason: r.revokedReason,
        blockedReason: r.blockedReason,
        lastSeenAt: r.lastSeenAt,
        interactionCount: r.interactionCount ?? 0,
        lastInteraction: r.lastInteraction,
        createdAt: r.channelCreatedAt,
        updatedAt: r.channelUpdatedAt,
      }));

    const interactionCount = channels.reduce(
      (sum, ch) => sum + (ch.interactionCount ?? 0),
      0,
    );
    const lastInteraction =
      channels.reduce(
        (max, ch) => Math.max(max, ch.lastInteraction ?? 0),
        0,
      ) || null;

    return {
      id: first.id,
      displayName: first.displayName,
      notes: first.notes,
      role: first.role,
      contactType: first.contactType,
      principalId: first.principalId,
      userFile: first.userFile,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
      interactionCount,
      lastInteraction,
      channels,
    };
  }
}

// ---------------------------------------------------------------------------
// Public response shapes
// ---------------------------------------------------------------------------

export interface ContactChannelShape {
  id: string;
  contactId: string;
  type: string;
  address: string;
  isPrimary: boolean;
  externalUserId: string | null;
  externalChatId: string | null;
  status: string | null;
  policy: string | null;
  verifiedAt: number | null;
  verifiedVia: string | null;
  inviteId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  interactionCount: number;
  lastInteraction: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ContactWithChannels {
  id: string;
  displayName: string;
  notes: string | null;
  role: string;
  contactType: string;
  principalId: string | null;
  userFile: string | null;
  createdAt: number;
  updatedAt: number;
  interactionCount: number;
  lastInteraction: number | null;
  channels: ContactChannelShape[];
}

interface AssistantContactRow {
  id: string;
  displayName: string;
  notes: string | null;
  role: string;
  contactType: string;
  principalId: string | null;
  userFile: string | null;
  createdAt: number;
  updatedAt: number;
  channelId: string | null;
  channelType: string | null;
  address: string | null;
  isPrimary: number | null;
  externalUserId: string | null;
  externalChatId: string | null;
  channelStatus: string | null;
  channelPolicy: string | null;
  verifiedAt: number | null;
  verifiedVia: string | null;
  inviteId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  interactionCount: number | null;
  lastInteraction: number | null;
  channelCreatedAt: number | null;
  channelUpdatedAt: number | null;
}
