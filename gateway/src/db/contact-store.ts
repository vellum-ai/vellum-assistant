import { type Database } from "bun:sqlite";

import { and, desc, eq, ne, sql } from "drizzle-orm";

import {
  type AssistantContactMetadata,
  type ContactRead,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import {
  type SqliteValue,
  assistantDbQuery,
  assistantDbRun,
} from "./assistant-db-proxy.js";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { contacts, contactChannels, ingressInvites } from "./schema.js";
import {
  type ContactInfoFields,
  emptyContactInfo,
  fetchInfoForContacts,
} from "./contacts-info-joiner.js";
import { getLogger } from "../logger.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";

const log = getLogger("contact-store");

export type Contact = typeof contacts.$inferSelect;
export type ContactChannel = typeof contactChannels.$inferSelect;
export type IngressInviteRow = typeof ingressInvites.$inferSelect;

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
    address: string,
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
          sql`${contactChannels.address} = ${address} COLLATE NOCASE`,
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

  // ── Gateway-native read with assistant info join ────────────────────────
  //
  // These methods read the ACL shape (contacts + contact_channels) from the
  // gateway DB and join the informational shape (notes, userFile, contactType,
  // assistant_contact_metadata) from the assistant DB in a single batched
  // query. Trust signals (interactionCount, lastInteraction, role) are
  // derived from gateway rows only — the assistant copy is not trusted for
  // ACL-relevant fields.
  //
  // Soft-fail: if the assistant DB read throws, info fields become null and
  // the ACL shape is still returned. A contact present in gateway but missing
  // from assistant (dual-write gap) also yields null info fields + a warning.

  /**
   * List contacts with channels (gateway) joined to info fields (assistant).
   *
   * Supports the same filter params as the daemon's handleListContacts:
   * limit, role, contactType. Search-style filters (query, channelAddress,
   * channelType) are NOT supported here — callers that need those should
   * fall back to the proxy path until a gateway-native search is built.
   *
   * Ordering mirrors the daemon: guardian role first, then updatedAt desc.
   */
  async listContactsWithInfo(opts?: {
    limit?: number;
    role?: string;
  }): Promise<ContactWithInfo[]> {
    const effectiveLimit = Math.min(opts?.limit ?? 50, 200);
    const conditions = [];
    if (opts?.role) conditions.push(eq(contacts.role, opts.role));

    // Step 1: Select contact IDs with the limit applied to CONTACTS (not
    // joined channel rows). The daemon path limits contact rows before
    // fetching channels — we match that to avoid returning fewer contacts
    // than expected when contacts have multiple channels.
    const contactRows = this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(conditions.length === 1 ? conditions[0] : undefined)
      .orderBy(
        sql`${contacts.role} = 'guardian' DESC`,
        desc(contacts.updatedAt),
      )
      .limit(effectiveLimit)
      .all();

    if (contactRows.length === 0) return [];
    const contactIds = contactRows.map((r) => r.id);

    // Step 2: Fetch contacts + their channels (no limit — all channels for
    // the selected contacts).
    const rows = this.db
      .select({ contact: contacts, channel: contactChannels })
      .from(contacts)
      .leftJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(
        sql`${contacts.id} IN (${sql.join(
          contactIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .orderBy(
        sql`${contacts.role} = 'guardian' DESC`,
        desc(contacts.updatedAt),
        // Primary channel first, then by creation time — mirrors the daemon
        // (assistant/src/contacts/contact-store.ts:141) and readAssistantContact.
        sql`${contactChannels.isPrimary} DESC`,
        contactChannels.createdAt,
      )
      .all();

    return this.joinInfoIntoContacts(rows);
  }

  /**
   * Get a single contact with channels + info. Returns null if the contact is
   * not in the gateway DB.
   */
  async getContactWithInfo(contactId: string): Promise<ContactWithInfo | null> {
    const rows = this.db
      .select({ contact: contacts, channel: contactChannels })
      .from(contacts)
      .leftJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(eq(contacts.id, contactId))
      .orderBy(
        // Primary channel first, then by creation time — mirrors the daemon
        // (assistant/src/contacts/contact-store.ts:141) and readAssistantContact.
        sql`${contactChannels.isPrimary} DESC`,
        contactChannels.createdAt,
      )
      .all();

    if (rows.length === 0) return null;
    const joined = await this.joinInfoIntoContacts(rows);
    return joined[0] ?? null;
  }

  // ── Rich reads (gateway ACL + assistant info, ContactRead contract) ──────
  //
  // listContactsRich / getContactRich assemble the shared ContactRead shape
  // (packages/gateway-client/src/gateway-ipc-contracts.ts) so the daemon can
  // relay its full contact read responses through the gateway IPC surface.
  // Identity + ACL/channel fields come from the gateway DB (source of truth);
  // info fields (notes, contactType, interactionCount, lastInteraction) come
  // from the assistant DB via assistantDbQuery. The assistant join is soft:
  // a failed or missing read degrades to gateway-DB-only values + a warning.
  //
  // Guardian display-name override is intentionally NOT applied here — the
  // daemon relay handler re-applies prepareContactResponse on the relayed
  // payload, keeping prompt logic on the daemon side.

  /**
   * List contacts in the shared ContactRead shape: gateway-DB identity + ACL
   * channels joined to assistant-DB info fields.
   *
   * Filters: `role` (gateway DB), `limit` (default 50, capped 200 to mirror
   * the daemon's listContacts). The daemon serves contactType-filtered list
   * reads natively (filtering in SQL before the limit) so a tight limit doesn't
   * under-return and an assistant-DB outage degrades rather than dropping every
   * row — the relay never carries a contactType filter.
   *
   * Thin adapter over `listContactsWithInfo` (shared assembly/soft-fail logic),
   * projected down to the ContactRead subset.
   *
   * Ordering mirrors the daemon's listContacts: guardian role first, then
   * updatedAt desc.
   */
  async listContactsRich(opts?: {
    limit?: number;
    role?: string;
  }): Promise<ContactRead[]> {
    const withInfo = await this.listContactsWithInfo({
      limit: opts?.limit,
      role: opts?.role,
    });
    return withInfo.map((c) => this.toContactRead(c));
  }

  /**
   * Get a single contact in the shared ContactRead shape, plus the assistant
   * metadata block for assistant-species contacts. Returns null if the
   * contact is absent from the gateway DB.
   *
   * Thin adapter over `getContactWithInfo`, projected down to ContactRead.
   */
  async getContactRich(contactId: string): Promise<{
    contact: ContactRead;
    assistantMetadata?: AssistantContactMetadata;
  } | null> {
    const withInfo = await this.getContactWithInfo(contactId);
    if (!withInfo) return null;

    const read = this.toContactRead(withInfo);
    if (withInfo.contactType === "assistant" && withInfo.assistantMetadata) {
      return {
        contact: read,
        assistantMetadata: {
          contactId,
          species: withInfo.assistantMetadata.species,
          metadata: withInfo.assistantMetadata.metadata,
        },
      };
    }
    return { contact: read };
  }

  /**
   * Project a ContactWithInfo down to the ContactRead subset (drops the
   * assistant-only/ACL-internal fields not on the shared contract). Channel
   * `externalUserId` is left null — the daemon's withChannelCompat is the sole
   * producer of that compat field on the relayed payload. status/policy default
   * like the DB columns (notNull, so a no-op on real rows) to satisfy the
   * non-null ContactRead channel contract.
   */
  private toContactRead(c: ContactWithInfo): ContactRead {
    return {
      id: c.id,
      displayName: c.displayName,
      role: c.role,
      notes: c.notes,
      contactType: c.contactType,
      interactionCount: c.interactionCount,
      lastInteraction: c.lastInteraction,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      channels: c.channels.map((ch) => ({
        id: ch.id,
        contactId: ch.contactId,
        type: ch.type,
        address: ch.address,
        isPrimary: ch.isPrimary,
        externalUserId: null,
        status: ch.status ?? "unverified",
        policy: ch.policy ?? "allow",
        verifiedAt: ch.verifiedAt,
        verifiedVia: ch.verifiedVia,
        lastSeenAt: ch.lastSeenAt,
        interactionCount: ch.interactionCount ?? 0,
        lastInteraction: ch.lastInteraction,
        revokedReason: ch.revokedReason,
        blockedReason: ch.blockedReason,
      })),
    };
  }

  /**
   * Group gateway contact+channel rows by contact, fetch info for all contact
   * IDs in one batch, and merge. Soft-fails on assistant DB error.
   */
  private async joinInfoIntoContacts(
    rows: { contact: Contact; channel: ContactChannel | null }[],
  ): Promise<ContactWithInfo[]> {
    // Group channels by contact, preserving first-seen contact order.
    const orderedIds: string[] = [];
    const byId = new Map<
      string,
      { contact: Contact; channels: ContactChannel[] }
    >();
    for (const row of rows) {
      const id = row.contact.id;
      if (!byId.has(id)) {
        orderedIds.push(id);
        byId.set(id, { contact: row.contact, channels: [] });
      }
      if (row.channel) {
        byId.get(id)!.channels.push(row.channel);
      }
    }

    let infoMap: Map<string, ContactInfoFields>;
    try {
      infoMap = await fetchInfoForContacts(orderedIds);
    } catch (err) {
      log.warn(
        { err, count: orderedIds.length },
        "listContactsWithInfo: assistant DB info read failed; returning ACL-only shape",
      );
      infoMap = new Map();
    }

    return orderedIds.map((id) => {
      const { contact, channels } = byId.get(id)!;
      const info = infoMap.get(id) ?? emptyContactInfo();
      if (!infoMap.has(id) && orderedIds.length > 0) {
        // Contact exists in gateway but not assistant DB — dual-write gap.
        // (Only log once would be nicer, but per-contact visibility matters.)
        log.warn(
          { contactId: id },
          "joinInfoIntoContacts: contact missing from assistant DB (dual-write gap); info fields null",
        );
      }
      return this.composeContactWithInfo(contact, channels, info);
    });
  }

  /**
   * Compose the public ContactWithInfo shape from gateway ACL rows + assistant
   * info fields. interactionCount/lastInteraction are derived from gateway
   * channels (trust signals live in gateway per the split).
   */
  private composeContactWithInfo(
    contact: Contact,
    channels: ContactChannel[],
    info: ContactInfoFields,
  ): ContactWithInfo {
    const interactionCount = channels.reduce(
      (sum, ch) => sum + (ch.interactionCount ?? 0),
      0,
    );
    const lastInteraction =
      channels.reduce((max, ch) => Math.max(max, ch.lastInteraction ?? 0), 0) ||
      null;

    return {
      id: contact.id,
      displayName: contact.displayName,
      role: contact.role,
      principalId: contact.principalId,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      channels: channels.map((ch) => ({
        id: ch.id,
        contactId: ch.contactId,
        type: ch.type,
        address: ch.address,
        isPrimary: ch.isPrimary,
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
      })),
      interactionCount,
      lastInteraction,
      notes: info.notes,
      userFile: info.userFile,
      contactType: info.contactType,
      assistantMetadata: info.assistantMetadata,
    };
  }

  /**
   * Looks up a non-revoked phone channel whose address matches the given
   * phone number. Used to detect callers whose number is registered but
   * not yet verified via DTMF challenge.
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
          sql`${contactChannels.address} = ${phoneNumber} COLLATE NOCASE`,
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
   * Update a channel's status and/or policy in the gateway DB, then
   * best-effort dual-write to the assistant DB.
   *
   * Returns the updated channel, or null if not found in either DB.
   * Throws if a blocked channel is being revoked (caller maps to 409).
   *
   * `revokedReason` / `blockedReason` are set based on the new status:
   *   - status="revoked" → revokedReason = reason ?? null, blockedReason = null
   *   - status="blocked" → blockedReason = reason ?? null, revokedReason = null
   *   - any other status → both reasons cleared to null
   *   - status unchanged → reasons left untouched (pass undefined)
   *
   * Channel ID resolution: the caller may pass an assistant-side channel ID
   * (the UI gets these from `readAssistantContact`). If the ID isn't found
   * in the gateway DB, we resolve it from the assistant DB by
   * (contactId, type, address) and then find the matching gateway channel.
   */
  async updateChannelStatus(
    channelId: string,
    params: {
      status?: string;
      policy?: string;
      reason?: string | null;
    },
  ): Promise<ContactChannel | null> {
    let gwChannel = this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, channelId))
      .get();

    // If not found in the gateway DB, resolve from the assistant DB by
    // logical key (contactId, type, address) and find the matching gateway row.
    if (!gwChannel) {
      const assistantChannel = await assistantDbQuery<{
        contactId: string;
        type: string;
        address: string;
      }>(
        "SELECT contact_id AS contactId, type, address FROM contact_channels WHERE id = ?",
        [channelId],
      );
      if (assistantChannel.length > 0) {
        const { contactId, type, address } = assistantChannel[0];
        gwChannel = this.db
          .select()
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.contactId, contactId),
              eq(contactChannels.type, type),
              sql`${contactChannels.address} = ${address} COLLATE NOCASE`,
            ),
          )
          .get();
      }
    }

    if (!gwChannel) return null;

    // Guard: cannot revoke a blocked channel.
    if (params.status === "revoked" && gwChannel.status === "blocked") {
      throw new CannotRevokeBlockedError(channelId);
    }

    const now = Date.now();
    const updateSet: Record<string, unknown> = { updatedAt: now };

    if (params.status !== undefined) {
      updateSet.status = params.status;
      if (params.status === "revoked") {
        updateSet.revokedReason = params.reason ?? null;
        updateSet.blockedReason = null;
      } else if (params.status === "blocked") {
        updateSet.blockedReason = params.reason ?? null;
        updateSet.revokedReason = null;
      } else {
        updateSet.revokedReason = null;
        updateSet.blockedReason = null;
      }
    }

    if (params.policy !== undefined) {
      updateSet.policy = params.policy;
    }

    this.db
      .update(contactChannels)
      .set(updateSet)
      .where(eq(contactChannels.id, gwChannel.id))
      .run();

    return this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, gwChannel.id))
      .get()!;
  }

  /**
   * Best-effort dual-write of a channel status/policy update to the
   * assistant DB. The gateway DB is the source of truth; the assistant
   * copy is a best-effort mirror. Failures are logged, not thrown.
   */
  async dualWriteChannelStatusToAssistantDb(
    channelId: string,
    params: {
      status?: string;
      policy?: string;
      revokedReason?: string | null;
      blockedReason?: string | null;
    },
  ): Promise<void> {
    const setClauses: string[] = [];
    const bind: (string | null)[] = [];

    if (params.status !== undefined) {
      setClauses.push("status = ?");
      bind.push(params.status);
    }
    if (params.policy !== undefined) {
      setClauses.push("policy = ?");
      bind.push(params.policy);
    }
    if (params.revokedReason !== undefined) {
      setClauses.push("revoked_reason = ?");
      bind.push(params.revokedReason);
    }
    if (params.blockedReason !== undefined) {
      setClauses.push("blocked_reason = ?");
      bind.push(params.blockedReason);
    }

    if (setClauses.length === 0) return;

    setClauses.push("updated_at = ?");
    bind.push(String(Date.now()));
    bind.push(channelId);

    const result = await assistantDbRun(
      `UPDATE contact_channels SET ${setClauses.join(", ")} WHERE id = ?`,
      bind,
    );

    // Legacy channels may have a different assistant-side ID. If the ID-keyed
    // update touched zero rows, resolve by (contactId, type, address) and
    // retry so the assistant mirror stays consistent.
    if (result.changes === 0) {
      const gwChannel = this.db
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, channelId))
        .get();
      if (!gwChannel) return;

      const logicalBind = bind.slice(0, -1); // drop the channelId
      logicalBind.push(gwChannel.contactId, gwChannel.type, gwChannel.address);
      await assistantDbRun(
        `UPDATE contact_channels SET ${setClauses.join(", ")}
         WHERE contact_id = ? AND type = ? AND address = ? COLLATE NOCASE`,
        logicalBind,
      );
    }
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
      `SELECT id, contact_id, type, address, is_primary,
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
  // Ingress invites (gateway DB only)
  // ---------------------------------------------------------------------------
  //
  // The gateway DB's ingress_invites table is the single source of truth for
  // contact invites. These methods are pure gateway-DB data access — the
  // assistant owns token generation/hashing (it supplies `id` and
  // `inviteCodeHash`), and any soft-fail dual-write lives in the HTTP handlers.

  listInvites(params: {
    sourceChannel?: string;
    status?: string;
    contactId?: string;
    limit?: number;
    offset?: number;
  }): IngressInviteRow[] {
    const conditions = [];
    if (params.sourceChannel !== undefined)
      conditions.push(eq(ingressInvites.sourceChannel, params.sourceChannel));
    if (params.status !== undefined)
      conditions.push(eq(ingressInvites.status, params.status));
    if (params.contactId !== undefined)
      conditions.push(eq(ingressInvites.contactId, params.contactId));

    return this.db
      .select()
      .from(ingressInvites)
      .where(conditions.length ? and(...conditions) : undefined)
      // Secondary sort on id keeps ordering (and offset pagination) stable when
      // multiple invites share a createdAt millisecond.
      .orderBy(desc(ingressInvites.createdAt), desc(ingressInvites.id))
      .limit(params.limit ?? 100)
      .offset(params.offset ?? 0)
      .all();
  }

  createInvite(params: {
    id: string;
    sourceChannel: string;
    inviteCodeHash: string;
    contactId: string;
    note?: string | null;
    maxUses?: number;
    expiresAt: number;
  }): IngressInviteRow {
    const now = Date.now();
    return this.db
      .insert(ingressInvites)
      .values({
        id: params.id,
        sourceChannel: params.sourceChannel,
        inviteCodeHash: params.inviteCodeHash,
        note: params.note ?? null,
        maxUses: params.maxUses ?? 1,
        useCount: 0,
        expiresAt: params.expiresAt,
        status: "active",
        contactId: params.contactId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  /**
   * Revoke an active invite. Idempotent: re-revoking a non-active invite
   * returns the current row without error, and returns null only when the
   * invite id doesn't exist.
   */
  revokeInvite(inviteId: string): IngressInviteRow | null {
    const now = Date.now();
    this.db
      .update(ingressInvites)
      .set({ status: "revoked", updatedAt: now })
      .where(
        and(
          eq(ingressInvites.id, inviteId),
          eq(ingressInvites.status, "active"),
        ),
      )
      .run();

    return this.getInviteById(inviteId);
  }

  /**
   * Record a redemption against an active invite: bump useCount, stamp
   * redeemedAt / redeemedBy*, and flip status to "redeemed" once useCount
   * reaches maxUses. Gated on status="active" so a revoked (or already
   * exhausted) invite can't be redeemed under a race — `updated` is false in
   * that case.
   */
  recordInviteRedemption(params: {
    inviteId: string;
    redeemedByExternalUserId?: string | null;
    redeemedByExternalChatId?: string | null;
  }): { updated: boolean; row: IngressInviteRow | null } {
    const now = Date.now();
    // RETURNING lets us tell a gated-out update (no active row matched) from a
    // successful one without depending on the driver's `changes` count.
    const updated = this.db
      .update(ingressInvites)
      .set({
        useCount: sql`${ingressInvites.useCount} + 1`,
        redeemedAt: now,
        redeemedByExternalUserId: params.redeemedByExternalUserId ?? null,
        redeemedByExternalChatId: params.redeemedByExternalChatId ?? null,
        status: sql`CASE WHEN ${ingressInvites.useCount} + 1 >= ${ingressInvites.maxUses} THEN 'redeemed' ELSE 'active' END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(ingressInvites.id, params.inviteId),
          eq(ingressInvites.status, "active"),
        ),
      )
      .returning()
      .all();

    return {
      updated: updated.length > 0,
      row: updated[0] ?? this.getInviteById(params.inviteId),
    };
  }

  getInviteById(inviteId: string): IngressInviteRow | null {
    return (
      this.db
        .select()
        .from(ingressInvites)
        .where(eq(ingressInvites.id, inviteId))
        .get() ?? null
    );
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

    // Canonicalize all channel addresses up front so every downstream path
    // (gateway DB, assistant DB dual-write, conflict checks) uses the
    // canonical form.
    const canonicalChannels = params.channels?.map((ch) => ({
      ...ch,
      address: canonicalizeInboundIdentity(ch.type, ch.address) ?? ch.address,
    }));

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
    if (!contactId && canonicalChannels?.length) {
      for (const ch of canonicalChannels) {
        const match = this.db
          .select({ contactId: contactChannels.contactId })
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.type, ch.type),
              sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
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
    if (canonicalChannels?.length) {
      this.syncChannels(contactId, canonicalChannels, now);
    }

    // ── 5. Dual-write to assistant DB (best-effort) ───────────────────
    const canonicalParams = canonicalChannels
      ? { ...params, channels: canonicalChannels }
      : params;
    try {
      await this.dualWriteContactToAssistantDb(
        contactId,
        canonicalParams,
        now,
        created,
      );
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

  /**
   * Merge two contacts: move channels from donor to survivor, delete the
   * donor. Notes concatenation is best-effort to the assistant DB.
   *
   * Gateway DB operations (channel move + donor delete) run in a single
   * transaction. The assistant DB notes concat is best-effort: if it fails,
   * the ACL state is still consistent (channels moved, donor gone) and the
   * failure is logged. This is the same soft-fail pattern used for info
   * reads throughout the contacts gateway.
   *
   * Returns the survivor contact with channels + info, or throws if either
   * contact is not found in the gateway DB.
   */
  async mergeContacts(
    keepId: string,
    mergeId: string,
  ): Promise<ContactWithInfo | null> {
    if (keepId === mergeId) {
      throw new MergeContactsError("Cannot merge a contact with itself");
    }

    const now = Date.now();

    // Verify both contacts exist in the gateway DB before touching anything.
    const keep = this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, keepId))
      .get();
    if (!keep) {
      throw new MergeContactsError(`Contact "${keepId}" not found`);
    }

    const merge = this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, mergeId))
      .get();
    if (!merge) {
      throw new MergeContactsError(`Contact "${mergeId}" not found`);
    }

    // Guard: cannot delete a guardian contact (same rule as handleDeleteContact).
    if (merge.role === "guardian") {
      throw new MergeContactsError(
        "Cannot merge away a guardian contact. Keep the guardian as the survivor instead.",
      );
    }

    // Gateway DB transaction: bump survivor timestamp, move channels, delete donor.
    this.db.transaction((tx) => {
      // Touch the survivor so list/read responses (ordered by updatedAt desc)
      // reflect the merge.
      tx.update(contacts)
        .set({ updatedAt: now })
        .where(eq(contacts.id, keepId))
        .run();

      const donorChannels = tx
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.contactId, mergeId))
        .all();

      for (const ch of donorChannels) {
        // Skip channels that already exist on the survivor by logical key.
        const exists = tx
          .select()
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.contactId, keepId),
              eq(contactChannels.type, ch.type),
              sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
            ),
          )
          .get();

        if (!exists) {
          tx.update(contactChannels)
            .set({ contactId: keepId, updatedAt: now })
            .where(eq(contactChannels.id, ch.id))
            .run();
        }
      }

      // Delete the donor (cascade removes remaining duplicate channels).
      tx.delete(contacts).where(eq(contacts.id, mergeId)).run();
    });

    // Best-effort: mirror the merge in the assistant DB (notes + channels + donor delete).
    try {
      await this.mergeInAssistantDb(
        keepId,
        mergeId,
        keep.displayName,
        keep.role,
        keep.principalId,
      );
    } catch (err) {
      log.warn(
        { keepId, mergeId, err },
        "mergeContacts: assistant DB mirror failed (best-effort)",
      );
      // The gateway DB donor is already gone, but if the assistant DB
      // donor lingers it will reappear in search-style queries (query,
      // channelAddress, channelType, contactType) that still proxy to
      // the daemon. Best-effort: move donor channels to survivor, then
      // delete the donor. Channel move must happen first because the
      // assistant DB cascades contact_channel deletion on contact delete.
      // If the reparent fails (e.g. FK violation because the survivor row
      // is missing from the assistant DB), skip the delete — cascading
      // would wipe the donor's channels, which is worse than a stale
      // donor row that reconciliation can clean up later.
      let reparentOk = false;
      try {
        await this.reparentDonorChannelsInAssistantDb(keepId, mergeId);
        reparentOk = true;
      } catch (chErr) {
        log.warn(
          { keepId, mergeId, chErr },
          "mergeContacts: compensation channel reparent failed — skipping donor delete to preserve channels",
        );
      }
      if (reparentOk) {
        try {
          await assistantDbRun("DELETE FROM contacts WHERE id = ?", [mergeId]);
        } catch (deleteErr) {
          log.error(
            { keepId, mergeId, deleteErr },
            "mergeContacts: assistant DB donor delete failed — donor may reappear in search results until reconciled",
          );
        }
      }
    }

    // Read back the survivor with info join.
    return this.getContactWithInfo(keepId);
  }

  /**
   * Mirror the merge in the assistant DB: concatenate notes, move donor
   * channels to survivor, delete the donor. Best-effort — failures are
   * logged by the caller.
   *
   * Order matters: notes concat → channel move → donor delete. If the
   * survivor doesn't exist in the assistant DB (dual-write gap), we insert
   * it with the combined notes so donor notes aren't lost when the donor
   * row is deleted.
   */
  private async mergeInAssistantDb(
    keepId: string,
    mergeId: string,
    keepDisplayName: string,
    keepRole: string,
    keepPrincipalId: string | null,
  ): Promise<void> {
    const now = Date.now();

    // 1. Concatenate notes.
    const rows = await assistantDbQuery<{ id: string; notes: string | null }>(
      "SELECT id, notes FROM contacts WHERE id IN (?, ?)",
      [keepId, mergeId],
    );
    const keepNotes = rows.find((r) => r.id === keepId)?.notes ?? null;
    const mergeNotes = rows.find((r) => r.id === mergeId)?.notes ?? null;
    const combined = [keepNotes, mergeNotes].filter(Boolean).join("\n") || null;

    // Try UPDATE first. If the survivor row doesn't exist in the assistant
    // DB (dual-write gap), INSERT it with the combined notes.
    const updateResult = await assistantDbRun(
      "UPDATE contacts SET notes = ?, updated_at = ? WHERE id = ?",
      [combined, String(now), keepId],
    );

    if (updateResult.changes === 0) {
      // Survivor row missing from assistant DB — create it with combined notes.
      // Use the gateway survivor's role/principalId so a guardian survivor
      // isn't downgraded to role=contact in the assistant mirror.
      const userFile = await this.resolveAssistantUserFileSlug(
        keepDisplayName,
        keepPrincipalId,
      );
      await assistantDbRun(
        `INSERT INTO contacts (id, display_name, notes, role, contact_type, principal_id, user_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'human', ?, ?, ?, ?)`,
        [
          keepId,
          keepDisplayName,
          combined,
          keepRole,
          keepPrincipalId,
          userFile,
          String(now),
          String(now),
        ],
      );
    }
    // 2. Move donor channels to survivor (skip dups by logical key).
    await this.reparentDonorChannelsInAssistantDb(keepId, mergeId);

    // 3. Delete the donor (cascade removes remaining duplicate channels).
    await assistantDbRun("DELETE FROM contacts WHERE id = ?", [mergeId]);
  }

  /**
   * Move donor channels to survivor in the assistant DB, skipping
   * duplicates by logical key (type + address COLLATE NOCASE). Used by
   * both the happy-path mirror and the compensation path after a mirror
   * failure. Must run before any donor delete to avoid cascade-wiping
   * channels that haven't been reparented yet.
   */
  private async reparentDonorChannelsInAssistantDb(
    keepId: string,
    mergeId: string,
  ): Promise<void> {
    const now = Date.now();
    const donorChannels = await assistantDbQuery<{
      id: string;
      type: string;
      address: string;
    }>("SELECT id, type, address FROM contact_channels WHERE contact_id = ?", [
      mergeId,
    ]);

    for (const ch of donorChannels) {
      const exists = await assistantDbQuery<{ id: string }>(
        "SELECT id FROM contact_channels WHERE contact_id = ? AND type = ? AND address = ? COLLATE NOCASE",
        [keepId, ch.type, ch.address],
      );
      if (exists.length === 0) {
        await assistantDbRun(
          "UPDATE contact_channels SET contact_id = ?, updated_at = ? WHERE id = ?",
          [keepId, String(now), ch.id],
        );
      }
    }
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
      // COLLATE NOCASE catches legacy lowercased rows (pre-migration m0005).
      const existing = this.db
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, contactId),
            eq(contactChannels.type, ch.type),
            sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
          ),
        )
        .get();

      if (existing) {
        const isBlocked = existing.status === "blocked";
        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (ch.isPrimary !== undefined) updateSet.isPrimary = ch.isPrimary;
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
        if (ch.verifiedVia !== undefined)
          updateSet.verifiedVia = ch.verifiedVia;
        if (ch.inviteId !== undefined) updateSet.inviteId = ch.inviteId;
        this.db
          .update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existing.id))
          .run();
        continue;
      }

      // Cross-contact conflict check — skip to avoid unique-address violations.
      // COLLATE NOCASE catches legacy lowercased rows.
      const conflict = this.db
        .select({ id: contactChannels.id })
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.type, ch.type),
            sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
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
          address: ch.address,
          isPrimary: ch.isPrimary ?? false,
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
      const existingCh = await assistantDbQuery<{ id: string; status: string }>(
        "SELECT id, status FROM contact_channels WHERE contact_id = ? AND type = ? AND address = ? COLLATE NOCASE",
        [contactId, ch.type, ch.address],
      );

      if (existingCh.length) {
        const isBlocked = existingCh[0].status === "blocked";
        const setParts: string[] = ["external_chat_id = ?", "updated_at = ?"];
        const setParams: SqliteValue[] = [ch.externalChatId ?? null, now];
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
          "SELECT id FROM contact_channels WHERE type = ? AND address = ? COLLATE NOCASE",
          [ch.type, ch.address],
        );
        if (conflict.length) continue;

        // Reuse the gateway channel ID so assistant and gateway channel
        // rows share the same UUID for the same logical channel.
        const gatewayChannel = this.db
          .select({ id: contactChannels.id })
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.contactId, contactId),
              eq(contactChannels.type, ch.type),
              sql`${contactChannels.address} = ${ch.address} COLLATE NOCASE`,
            ),
          )
          .get();
        const channelId = gatewayChannel?.id ?? crypto.randomUUID();

        await assistantDbRun(
          `INSERT INTO contact_channels
             (id, contact_id, type, address, is_primary,
              external_chat_id,
              status, policy, interaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            channelId,
            contactId,
            ch.type,
            ch.address,
            ch.isPrimary ? 1 : 0,
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
      channels.reduce((max, ch) => Math.max(max, ch.lastInteraction ?? 0), 0) ||
      null;

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

/**
 * Gateway-native contact shape: ACL fields (gateway DB) joined to assistant-
 * owned info fields. The info fields are nullable because the assistant DB may
 * be unreachable (soft-fail) or the contact may be absent from it (dual-write
 * gap) — in either case the ACL shape is still servable. `interactionCount`
 * and `lastInteraction` are derived from gateway channels (trust signals live
 * in gateway per the split). `assistantMetadata` is present only for assistant-
 * species contacts with a metadata row.
 */
export interface ContactWithInfo {
  id: string;
  displayName: string;
  role: string;
  principalId: string | null;
  createdAt: number;
  updatedAt: number;
  channels: ContactChannelShape[];
  interactionCount: number;
  lastInteraction: number | null;
  // assistant-owned info fields (null in degraded mode)
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  assistantMetadata: {
    species: string;
    metadata: Record<string, unknown> | null;
  } | null;
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

/**
 * Thrown by `updateChannelStatus` when the caller attempts to revoke a
 * channel that is currently blocked. The caller maps this to HTTP 409.
 */
export class CannotRevokeBlockedError extends Error {
  readonly channelId: string;
  constructor(channelId: string) {
    super(
      "Cannot revoke a blocked channel. Unblock it first or leave it blocked.",
    );
    this.name = "CannotRevokeBlockedError";
    this.channelId = channelId;
  }
}

/**
 * Thrown by `mergeContacts` for validation errors (self-merge, contact not
 * found). The caller maps this to HTTP 400.
 */
export class MergeContactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeContactsError";
  }
}
