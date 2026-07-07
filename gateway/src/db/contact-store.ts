import { type Database } from "bun:sqlite";

import { and, desc, eq, gt, ne, sql } from "drizzle-orm";

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
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import {
  fetchContactsInfoBatch,
  lookupContactChannelIdentity,
  listContactUserFileSlugs,
} from "../ipc/contacts-info-client.js";
import { getLogger } from "../logger.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";

const log = getLogger("contact-store");

/**
 * Reason that marks the sanctioned guardian-binding teardown. A guardian
 * channel may only be downgraded with this reason; any other reason is
 * rejected by the guardian guard (invariant 4).
 */
export const GUARDIAN_BINDING_REVOKE_REASON = "guardian_binding_revoked";

export type Contact = typeof contacts.$inferSelect;
export type ContactChannel = typeof contactChannels.$inferSelect;
export type IngressInviteRow = typeof ingressInvites.$inferSelect;

/**
 * Sentinel stored in `invite_code_hash` for invites without a 6-digit code
 * (e.g. voice invites, which carry `voice_code_hash` instead). The column
 * stays NOT NULL because relaxing it forces a drizzle-push table rebuild that
 * corrupts existing DBs (see the schema.ts comment); m0009 owns normalization.
 * Never matches a real lookup — real code hashes are SHA-256 hex.
 */
export const NO_INVITE_CODE_HASH = "";

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

  /**
   * Guardian contact ids from the gateway DB (source of truth). Singular per
   * workspace, but returns a list to be safe.
   */
  listGuardianContactIds(): string[] {
    return this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.role, "guardian"))
      .all()
      .map((r) => r.id);
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
    ids?: string[];
  }): Promise<ContactWithInfo[]> {
    // Explicit id set: the caller has already selected/filtered the contacts
    // (e.g. daemon-native search) and only needs the gateway-owned shape for
    // them. Skip the role/limit query entirely — the ids ARE the filter.
    let contactIds: string[];
    if (opts?.ids) {
      contactIds = [...new Set(opts.ids)].slice(0, 200);
      if (contactIds.length === 0) return [];
    } else {
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
      contactIds = contactRows.map((r) => r.id);
    }

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
        // (assistant/src/contacts/contact-store.ts:141).
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
        // (assistant/src/contacts/contact-store.ts:141).
        sql`${contactChannels.isPrimary} DESC`,
        contactChannels.createdAt,
      )
      .all();

    if (rows.length === 0) return null;
    const joined = await this.joinInfoIntoContacts(rows);
    return joined[0] ?? null;
  }

  /**
   * Batched gateway-DB ACL read keyed by contact id. Reads ONLY the gateway DB
   * (the ACL source of truth) — never the assistant DB. Used to overlay
   * authoritative ACL onto daemon-forwarded (filtered/search) contact reads,
   * which carry neutral ACL.
   *
   * Returns a map of contactId → { role, channels }, where `channels` is keyed
   * by channel `id`. Empty input → empty map. Contacts/channels absent from the
   * gateway are simply absent from the map (the caller leaves them untouched).
   */
  async getAclByContactIds(
    ids: string[],
  ): Promise<Map<string, ContactAcl>> {
    const result = new Map<string, ContactAcl>();
    if (ids.length === 0) return result;

    const rows = this.db
      .select({ contact: contacts, channel: contactChannels })
      .from(contacts)
      .leftJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(
        sql`${contacts.id} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .all();

    for (const row of rows) {
      const id = row.contact.id;
      let entry = result.get(id);
      if (!entry) {
        entry = { role: row.contact.role, channels: new Map() };
        result.set(id, entry);
      }
      const ch = row.channel;
      if (ch) {
        entry.channels.set(ch.id, {
          id: ch.id,
          type: ch.type,
          address: ch.address,
          status: ch.status,
          policy: ch.policy,
          verifiedAt: ch.verifiedAt,
          verifiedVia: ch.verifiedVia,
          revokedReason: ch.revokedReason,
          blockedReason: ch.blockedReason,
        });
      }
    }

    return result;
  }

  // ── Rich reads (gateway ACL + assistant info, ContactRead contract) ──────
  //
  // listContactsRich / getContactRich assemble the shared ContactRead shape
  // (packages/gateway-client/src/gateway-ipc-contracts.ts) so the daemon can
  // relay its full contact read responses through the gateway IPC surface.
  // Identity + ACL/channel fields come from the gateway DB (source of truth);
  // info fields (notes, contactType, interactionCount, lastInteraction) come
  // from the assistant DB via typed daemon IPC. The assistant join is soft:
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
   * the daemon's listContacts), or an explicit `ids` set (the daemon's telemetry
   * hydration for its native search/contactType reads — bypasses role/limit).
   * The daemon serves contactType-filtered list reads natively (filtering in SQL
   * before the limit) so a tight limit doesn't under-return and an assistant-DB
   * outage degrades rather than dropping every row — the relay never carries a
   * contactType filter.
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
    ids?: string[];
  }): Promise<ContactRead[]> {
    const withInfo = await this.listContactsWithInfo({
      limit: opts?.limit,
      role: opts?.role,
      ids: opts?.ids,
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
   * Resolve a channel id by its logical (type, address) key, falling back to
   * (type, externalChatId) for legacy/imported contacts. Gateway DB only.
   */
  findChannelIdByAddress(
    type: string,
    address: string,
    externalChatId?: string | null,
  ): string | undefined {
    const byAddress = this.db
      .select({ id: contactChannels.id })
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, type),
          sql`${contactChannels.address} = ${address} COLLATE NOCASE`,
        ),
      )
      .limit(1)
      .get();
    if (byAddress) return byAddress.id;

    if (externalChatId == null) return undefined;
    return this.db
      .select({ id: contactChannels.id })
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, type),
          eq(contactChannels.externalChatId, externalChatId),
        ),
      )
      .limit(1)
      .get()?.id;
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
   * Update a channel's status and/or policy in the gateway DB.
   *
   * Returns the updated channel, or null if not found.
   * Throws if a blocked channel is being revoked (caller maps to 409).
   *
   * `revokedReason` / `blockedReason` are set based on the new status:
   *   - status="revoked" → revokedReason = reason ?? null, blockedReason = null
   *   - status="blocked" → blockedReason = reason ?? null, revokedReason = null
   *   - any other status → both reasons cleared to null
   *   - status unchanged → reasons left untouched (pass undefined)
   *
   * Gateway DB is the source of truth; a channel absent from the gateway
   * returns null.
   */
  async updateChannelStatus(
    channelId: string,
    params: {
      status?: string;
      policy?: string;
      reason?: string | null;
    },
  ): Promise<ContactChannel | null> {
    const gwChannel = await this.resolveGatewayChannel(channelId);

    // Gateway DB is the source of truth; a channel absent from the gateway
    // has no status to update.
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
   * Resolve a gateway channel row by id, falling back to its logical
   * (type, address) key when the id-based lookup misses. Legacy channels can
   * live under a different gateway UUID than the assistant id, so the id
   * passed by callers may not be the gateway row's id. `(type, address)` is
   * globally unique, so a split-brain row living under a different contact id
   * is the canonical gateway ACL to resolve to — not a row to re-mirror
   * (which would hit the unique constraint).
   */
  private async resolveGatewayChannel(
    channelId: string,
  ): Promise<ContactChannel | undefined> {
    const byId = this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, channelId))
      .get();
    if (byId) return byId;

    const assistantChannel = await lookupContactChannelIdentity({ channelId });
    if (!assistantChannel) return undefined;

    // Resolve by the gateway's unique key (type, address). The gateway row may
    // live under a different contact than the assistant mirror — m0006 reconcile
    // skips mirroring when (type, address) already exists under any contact — so
    // contactId is not part of the lookup; the resolved row's contact is trusted.
    const { type, address } = assistantChannel;
    return this.db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, type),
          sql`${contactChannels.address} = ${address} COLLATE NOCASE`,
        ),
      )
      .get();
  }

  /**
   * Mark a channel as verified. Sets `status="active"`, stamps
   * `verifiedAt=now`, and records `verifiedVia` (default `"manual"` for the
   * guardian-attestation path; `"challenge"` for the code-exchange path) on
   * the audit trail.
   *
   * Atomic + idempotent. The UPDATE is gated on the row not already being
   * `(status="active" AND verified_via=verifiedVia)`, so two concurrent
   * verify requests can't both write — exactly one will see `changes=1`
   * and the other will see `changes=0`. Both still return the post-state
   * row.
   *
   * Gateway DB is the source of truth; a channel absent from the gateway
   * returns `null`.
   */
  async markChannelVerified(
    channelId: string,
    verifiedVia: "challenge" | "manual" = "manual",
  ): Promise<{
    channel: ContactChannel;
    didWrite: boolean;
  } | null> {
    // Legacy channels may live under a different gateway id than the assistant
    // channel id passed in; resolve the gateway row (by id, then by logical
    // (type,address) key) before keying writes on it. Gateway DB is the source
    // of truth; a channel absent from the gateway returns null.
    const gwChannel = await this.resolveGatewayChannel(channelId);
    if (!gwChannel) return null;
    const gwChannelId = gwChannel.id;

    const now = Date.now();
    const raw = (this.db as unknown as { $client: Database }).$client;
    const result = raw
      .prepare(
        `UPDATE contact_channels
           SET status = ?, verified_at = ?, verified_via = ?, updated_at = ?
         WHERE id = ?
           AND (status != ? OR verified_via != ? OR verified_via IS NULL)`,
      )
      .run("active", now, verifiedVia, now, gwChannelId, "active", verifiedVia);

    const after = this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, gwChannelId))
      .get();

    if (!after) return null;
    const didWrite = result.changes > 0;

    return { channel: after, didWrite };
  }

  /**
   * Downgrade a channel to `revoked` (verification-revoke outcome).
   * Gateway DB is source of truth.
   *
   * Guardian guard (invariant 4): a guardian contact's channel may only be
   * downgraded via the sanctioned guardian-binding teardown
   * (`reason="guardian_binding_revoked"`). Any other reason on a guardian
   * channel is rejected here at the boundary rather than silently applied.
   *
   * Gateway DB is the source of truth; a channel absent from the gateway
   * returns `null`.
   */
  async markChannelRevoked(
    channelId: string,
    reason?: string,
  ): Promise<{ channel: ContactChannel; didWrite: boolean } | null> {
    // Legacy channels may live under a different gateway id than the assistant
    // channel id passed in; resolve the gateway row before keying writes on it.
    // Gateway DB is the source of truth; a channel absent from the gateway
    // returns null.
    const channel = await this.resolveGatewayChannel(channelId);
    if (!channel) return null;
    const gwChannelId = channel.id;

    const contact = this.getContact(channel.contactId);
    if (
      contact?.role === "guardian" &&
      reason !== GUARDIAN_BINDING_REVOKE_REASON
    ) {
      log.warn(
        { channelId, reason },
        "markChannelRevoked: rejected guardian channel downgrade",
      );
      throw new CannotDowngradeGuardianError(channelId);
    }

    // A blocked channel stays blocked: blocked is stricter than revoked, and
    // downgrading it would clear blockedReason and make the actor re-claimable.
    // Mirrors the blocked→revoked guard in updateChannelStatus; here it's a
    // no-op so a guardian-binding teardown over a blocked channel doesn't fail.
    if (channel.status === "blocked") {
      return { channel, didWrite: false };
    }

    // Idempotent: a row already revoked with this reason is a no-op — skip the
    // write + dual-write (matches markChannelVerified).
    const alreadyRevoked =
      channel.status === "revoked" &&
      channel.revokedReason === (reason ?? null);
    if (alreadyRevoked) {
      return { channel, didWrite: false };
    }

    this.db
      .update(contactChannels)
      .set({
        status: "revoked",
        revokedReason: reason ?? null,
        blockedReason: null,
        updatedAt: Date.now(),
      })
      .where(eq(contactChannels.id, gwChannelId))
      .run();

    const after = this.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, gwChannelId))
      .get();
    if (!after) return null;

    return { channel: after, didWrite: true };
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

    return (
      this.db
        .select()
        .from(ingressInvites)
        .where(conditions.length ? and(...conditions) : undefined)
        // Secondary sort on id keeps ordering (and offset pagination) stable when
        // multiple invites share a createdAt millisecond.
        .orderBy(desc(ingressInvites.createdAt), desc(ingressInvites.id))
        .limit(params.limit ?? 100)
        .offset(params.offset ?? 0)
        .all()
    );
  }

  createInvite(params: {
    id: string;
    sourceChannel: string;
    inviteCodeHash?: string | null;
    contactId: string;
    note?: string | null;
    maxUses?: number;
    expiresAt: number;
    tokenHash?: string | null;
    voiceCodeHash?: string | null;
    voiceCodeDigits?: number | null;
    expectedExternalUserId?: string | null;
    friendName?: string | null;
    guardianName?: string | null;
    sourceConversationId?: string | null;
  }): IngressInviteRow {
    const now = Date.now();
    return this.db
      .insert(ingressInvites)
      .values({
        id: params.id,
        sourceChannel: params.sourceChannel,
        inviteCodeHash: params.inviteCodeHash ?? NO_INVITE_CODE_HASH,
        tokenHash: params.tokenHash ?? null,
        voiceCodeHash: params.voiceCodeHash ?? null,
        voiceCodeDigits: params.voiceCodeDigits ?? null,
        expectedExternalUserId: params.expectedExternalUserId ?? null,
        friendName: params.friendName ?? null,
        guardianName: params.guardianName ?? null,
        sourceConversationId: params.sourceConversationId ?? null,
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
  }): { updated: boolean } {
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
      .returning({ id: ingressInvites.id })
      .all();

    return { updated: updated.length > 0 };
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

  /**
   * Find an invite by its link-token hash, regardless of status. Token hashes
   * are 256-bit and globally unique, so no channel scoping is needed; callers
   * inspect status/expiry themselves to produce precise error messaging.
   */
  findInviteByTokenHash(tokenHash: string): IngressInviteRow | null {
    return (
      this.db
        .select()
        .from(ingressInvites)
        .where(eq(ingressInvites.tokenHash, tokenHash))
        .get() ?? null
    );
  }

  /**
   * Find an active invite by its 6-digit invite code hash, scoped to a
   * specific source channel. Channel scoping is required because 6-digit
   * codes are drawn from a small keyspace and can collide across channels —
   * without it, `.get()` could return an arbitrary match, leading to
   * nondeterministic redemption or false channel-mismatch failures.
   */
  findInviteByCodeHash(
    codeHash: string,
    sourceChannel: string,
  ): IngressInviteRow | null {
    if (codeHash === NO_INVITE_CODE_HASH) return null;
    return (
      this.db
        .select()
        .from(ingressInvites)
        .where(
          and(
            eq(ingressInvites.inviteCodeHash, codeHash),
            eq(ingressInvites.sourceChannel, sourceChannel),
            eq(ingressInvites.status, "active"),
          ),
        )
        .get() ?? null
    );
  }

  /**
   * Find an active, not-yet-expired invite by its 6-digit invite code hash
   * without channel scoping. Used as a fallback after a channel-scoped lookup
   * fails, to distinguish "code doesn't exist" from "code exists but for a
   * different channel" — the latter should produce channel-mismatch messaging
   * instead of silently falling through.
   */
  findInviteByCodeHashAnyChannel(codeHash: string): IngressInviteRow | null {
    if (codeHash === NO_INVITE_CODE_HASH) return null;
    return (
      this.db
        .select()
        .from(ingressInvites)
        .where(
          and(
            eq(ingressInvites.inviteCodeHash, codeHash),
            eq(ingressInvites.status, "active"),
            gt(ingressInvites.expiresAt, Date.now()),
          ),
        )
        .get() ?? null
    );
  }

  /**
   * Find all active voice invites bound to a specific caller identity.
   * Used by the voice invite redemption flow to locate candidate invites
   * before code hash matching.
   */
  findActiveVoiceInvites(expectedExternalUserId: string): IngressInviteRow[] {
    return this.db
      .select()
      .from(ingressInvites)
      .where(
        and(
          eq(ingressInvites.sourceChannel, "phone"),
          eq(ingressInvites.status, "active"),
          eq(ingressInvites.expectedExternalUserId, expectedExternalUserId),
        ),
      )
      .all();
  }

  /**
   * Transition an invite's status to 'expired'. Safe to call on an already
   * expired/revoked/redeemed invite — the WHERE clause scopes the update to
   * 'active' rows so it becomes a no-op (returns false) in that case.
   */
  markInviteExpired(inviteId: string): boolean {
    const updated = this.db
      .update(ingressInvites)
      .set({ status: "expired", updatedAt: Date.now() })
      .where(
        and(
          eq(ingressInvites.id, inviteId),
          eq(ingressInvites.status, "active"),
        ),
      )
      .returning({ id: ingressInvites.id })
      .all();
    return updated.length > 0;
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
   *  2. Match by (type, address) on a provided channel in the gateway DB.
   *  3. Create: adopt an existing assistant-DB contact id for the same channel
   *     (canonical-id heal), else mint a fresh id.
   *
   * Steps 2 and 3 (channel-match + assistant-id adoption) run on the create
   * path only — when no explicit `id` is supplied. An explicit id is an update
   * and keys the gateway row + assistant mirror to that id directly, so an edit
   * can't retarget another contact's metadata.
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
   *
   * `displayName` is omit-to-preserve: when undefined, an existing contact's
   * name is left untouched (gateway DB + assistant mirror). A brand-new
   * contact with no name falls back to the first channel's canonical address.
   */
  async upsertContact(params: {
    id?: string;
    displayName?: string;
    notes?: string | null;
    contactType?: string;
    assistantMetadata?: {
      species: string;
      metadata?: Record<string, unknown> | null;
    };
    channels?: Array<{
      // Internal: heal/adopt path sets this to the assistant channel's id so the
      // gateway INSERT shares one canonical id. Public callers omit it (a fresh
      // UUID is minted). Never honored on the existing-channel UPDATE path.
      id?: string;
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
  }): Promise<{ contact: ContactWithInfo; created: boolean }> {
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

    // Fallback name for a brand-new contact created without an explicit
    // displayName: the first channel's canonical address, else "Unknown".
    const newContactName =
      params.displayName ?? canonicalChannels?.[0]?.address ?? "Unknown";

    // Omit-to-preserve: only overwrite an existing contact's displayName when
    // the caller supplied one. Mirrors the role/principalId preservation.
    const updateContactName = (id: string): void => {
      const updateSet: Record<string, unknown> = { updatedAt: now };
      if (params.displayName !== undefined) {
        updateSet.displayName = params.displayName;
      }
      this.db.update(contacts).set(updateSet).where(eq(contacts.id, id)).run();
    };

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
        updateContactName(contactId);
      } else {
        this.db
          .insert(contacts)
          .values({
            id: contactId,
            displayName: newContactName,
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
          updateContactName(contactId);
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
          displayName:
            params.displayName ?? canonicalChannels?.[0]?.address ?? "Unknown",
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
      await this.dualWriteContactToAssistantDb(contactId, canonicalParams, now);
    } catch (err) {
      log.warn(
        { contactId, err },
        "upsertContact: assistant DB dual-write failed (best-effort)",
      );
    }

    // ── 6. Read back full contact shape (best-effort) ─────────────────
    // Source ACL (role/principalId, channel status/policy/verified_*) from the
    // gateway DB — the just-written source of truth — and overlay assistant-
    // owned info. The assistant mirror would report stale unverified/allow/
    // contact defaults for fresh creates.
    const fullContact = await this.getContactWithInfo(contactId).catch((err) => {
      log.warn(
        { contactId, err },
        "upsertContact: gateway read-back failed; returning gateway fallback",
      );
      return null;
    });

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
        assistantMetadata: null,
      },
      created,
    };
  }

  /**
   * Merge two contacts: move channels from donor to survivor, delete the
   * donor. The assistant-DB identity mirror is best-effort.
   *
   * Gateway DB operations (channel move + donor delete) run in a single
   * transaction. The mirror is one transactional daemon op
   * (`contacts_mirror_merge_contact`: notes concat + channel reparent + donor
   * delete), so it either fully applies or not at all — a failure is logged
   * and left to reconciliation, same soft-fail pattern as info reads
   * throughout the contacts gateway.
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

    // Best-effort mirror: one transactional daemon op (notes concat + channel
    // reparent + donor delete), so partial application is impossible and no
    // compensation is needed — a failed mirror leaves a stale donor for
    // reconciliation. The user_file slug is resolved here because its
    // principal-sibling reuse needs the gateway DB; the daemon uses it only
    // for the dual-write-gap INSERT of a survivor missing from the mirror,
    // so a resolution failure degrades to undefined (null user_file on that
    // rare INSERT) rather than skipping the merge op.
    try {
      let resolvedUserFile: string | undefined;
      try {
        resolvedUserFile = await this.resolveAssistantUserFileSlug(
          keep.displayName,
          keep.principalId,
        );
      } catch (slugErr) {
        log.warn(
          { keepId, mergeId, slugErr },
          "mergeContacts: user_file slug resolution failed — sending mirror merge without it",
        );
      }
      await ipcCallAssistant("contacts_mirror_merge_contact", {
        body: {
          keepContactId: keepId,
          mergeContactId: mergeId,
          keepDisplayName: keep.displayName,
          resolvedUserFile,
        },
      });
    } catch (err) {
      log.warn(
        { keepId, mergeId, err },
        "mergeContacts: assistant DB mirror failed (best-effort)",
      );
    }

    // Read back the survivor with info join.
    return this.getContactWithInfo(keepId);
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

      // New channel. Honor an adopted assistant channel id (heal path) so both
      // DBs share one canonical id; otherwise mint a fresh UUID.
      this.db
        .insert(contactChannels)
        .values({
          id: ch.id ?? crypto.randomUUID(),
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
  ): Promise<void> {
    // The mirror always targets the gateway contactId — the SAME id the gateway
    // row + channels were written under. On create, any assistant-only contact
    // was already adopted onto this id in upsertContact, so both DBs converge.
    // On update (explicit id), this matches syncChannels' skip-on-cross-contact
    // behavior so an edit can't retarget another contact's metadata.
    const existing = await assistantDbQuery<{ userFile: string | null }>(
      "SELECT user_file AS userFile FROM contacts WHERE id = ?",
      [contactId],
    );

    if (existing.length) {
      // Dynamic SET clause: only touch fields the caller actually provided.
      // role / principal_id are intentionally never updated from this path —
      // they're not in the params surface and the assistant DB already holds
      // the values written by guardian-bootstrap. display_name is
      // omit-to-preserve so a sparse upsert can't revert a custom name.
      const setParts: string[] = ["updated_at = ?"];
      const setParams: SqliteValue[] = [now];

      if (params.displayName !== undefined) {
        setParts.push("display_name = ?");
        setParams.push(params.displayName);
      }
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
      const displayName =
        params.displayName ?? params.channels?.[0]?.address ?? "Unknown";
      const userFile = await this.resolveAssistantUserFileSlug(
        displayName,
        null,
      );
      await assistantDbRun(
        `INSERT INTO contacts
           (id, display_name, notes, contact_type,
            user_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          displayName,
          params.notes ?? null,
          params.contactType ?? "human",
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
      const existingCh = await assistantDbQuery<{ id: string }>(
        "SELECT id FROM contact_channels WHERE contact_id = ? AND type = ? AND address = ? COLLATE NOCASE",
        [contactId, ch.type, ch.address],
      );

      if (existingCh.length) {
        // Omit-to-preserve: only overwrite external_chat_id when the caller
        // supplied one, mirroring syncChannels (gateway DB). A sparse upsert
        // (no externalChatId) must not clear an existing delivery chat id.
        const setParts: string[] = ["updated_at = ?"];
        const setParams: SqliteValue[] = [now];
        if (ch.externalChatId !== undefined) {
          setParts.push("external_chat_id = ?");
          setParams.push(ch.externalChatId);
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

        // Reuse the gateway channel ID so assistant and gateway channel rows
        // share the same UUID for the same logical channel.
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
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            channelId,
            contactId,
            ch.type,
            ch.address,
            ch.isPrimary ? 1 : 0,
            ch.externalChatId ?? null,
            now,
            now,
          ],
        );
      }
    }
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
      // principalId is gateway-owned: resolve sibling contact ids from the
      // gateway DB (source of truth), then read the assistant-owned user_file
      // for those ids from the assistant DB.
      const siblingIds = getGatewayDb()
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.principalId, principalId))
        .all()
        .map((r) => r.id);
      if (siblingIds.length) {
        const infos = await fetchContactsInfoBatch(siblingIds);
        const siblingFile = infos.find((i) => i.userFile != null)?.userFile;
        if (siblingFile) {
          return siblingFile;
        }
      }
    }

    const slug =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100) || "user";

    const userFiles = await listContactUserFileSlugs(slug);
    const taken = new Set(userFiles.map((f) => f.toLowerCase()));

    const base = `${slug}.md`;
    if (!taken.has(base)) return base;

    for (let i = 2; i <= 100; i++) {
      const candidate = `${slug}-${i}.md`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${slug}-${crypto.randomUUID().slice(0, 8)}.md`;
  }

}

// ---------------------------------------------------------------------------
// Public response shapes
// ---------------------------------------------------------------------------

/**
 * Authoritative per-channel ACL from the gateway DB, keyed by channel `id` in
 * `ContactAcl.channels`. Used to overlay neutral ACL on daemon-forwarded reads.
 */
export interface ChannelAcl {
  id: string;
  type: string;
  address: string;
  status: string | null;
  policy: string | null;
  verifiedAt: number | null;
  verifiedVia: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
}

/** Contact-level role + channel ACL map (channel id → ChannelAcl). */
export interface ContactAcl {
  role: string;
  channels: Map<string, ChannelAcl>;
}

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
 * Thrown by `markChannelRevoked` when a downgrade would strip a guardian
 * contact's channel via anything other than the sanctioned guardian-binding
 * teardown. The caller maps this to HTTP 409.
 */
export class CannotDowngradeGuardianError extends Error {
  readonly channelId: string;
  readonly statusCode = 409;
  readonly code = "CONFLICT";
  constructor(channelId: string) {
    super(
      "Cannot downgrade a guardian channel. Revoke the guardian binding instead.",
    );
    this.name = "CannotDowngradeGuardianError";
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
