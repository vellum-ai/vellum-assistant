/**
 * Gateway SQLite schema — Drizzle ORM table declarations.
 *
 * This is the single source of truth for the gateway database schema.
 * Tables are created declaratively via CREATE TABLE IF NOT EXISTS at
 * startup (see connection.ts). Drizzle provides typed query access.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export const slackActiveThreads = sqliteTable("slack_active_threads", {
  threadTs: text("thread_ts").primaryKey(),
  // Channel hosting the active thread. Nullable because SQLite's
  // ALTER TABLE ADD COLUMN cannot add a NOT NULL column without a default
  // (https://sqlite.org/lang_altertable.html#alter_table_add_column);
  // legacy rows pre-dating this column carry NULL until they age out of
  // the thread TTL window, and reconnect catch-up enumeration filters them.
  channelId: text("channel_id"),
  trackedAt: integer("tracked_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  // Set when the thread was explicitly detached (the Slack mute command or
  // the daemon's detach IPC route). NULL = actively tracked. A detached row
  // is kept as a marker — rather than deleted — so the Socket Mode echo of
  // the bot's own mute confirmation cannot silently re-arm the thread it
  // just muted. An explicit human re-engagement (trackThread) clears it.
  detachedAt: integer("detached_at"),
});

export const slackSeenEvents = sqliteTable("slack_seen_events", {
  // Generic dedup key. Holds either a Slack `event_id` (live path) or a
  // synthetic `msg:${channel}:${ts}` key (reconnect catch-up path) so both
  // paths dedup symmetrically against the same row. The physical column
  // name `event_id` is a historical artefact; semantically this is a
  // dedup key, not strictly an event ID.
  eventId: text("event_id").primaryKey(),
  seenAt: integer("seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/**
 * Persistent high-watermark for Slack Socket Mode catch-up.
 *
 * Slack does not buffer events for disconnected Socket Mode clients
 * (https://api.slack.com/apis/socket-mode), so missed @mentions and DMs
 * during a reconnect window are recovered via `conversations.history` /
 * `conversations.replies`. This row stores the latest accepted event
 * timestamp so catch-up knows where to resume from. A single row keyed
 * by `'global'` is used; per-channel watermarks would add precision but
 * are not necessary because the compound `msg:${channel}:${ts}` dedup
 * absorbs the resulting overlap.
 */
export const slackLastSeenTs = sqliteTable("slack_last_seen_ts", {
  key: text("key").primaryKey(),
  ts: text("ts").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Persisted bot identity for any channel adapter.
 *
 * Each channel adapter (Slack, Telegram, Discord, etc.) resolves the bot's
 * own identity via a provider-specific API call (e.g. Slack `auth.test`,
 * Telegram `getMe`). The bot's identity is a deployment constant — it
 * never changes for a given token. Persisting it here decouples the gateway
 * from a successful API call at every startup: the first successful
 * resolution writes the row, and subsequent startups load it directly.
 * The provider API is still called to validate the token; a transient
 * failure falls back to the persisted value instead of leaving the gateway
 * unable to identify its own messages.
 *
 * One row per channel type. `channel_type` is the primary key.
 */
export const channelBotIdentity = sqliteTable("channel_bot_identity", {
  /** Channel adapter type (e.g. `'slack'`, `'telegram'`, `'discord'`). */
  channelType: text("channel_type").primaryKey(),
  /** The bot's user ID on the channel (e.g. Slack `U01ABC123`, Telegram numeric ID). */
  userId: text("user_id").notNull(),
  /** The bot's display name / username on the channel. */
  username: text("username"),
  /** Channel-specific metadata as JSON (e.g. Slack team name, Telegram first_name). */
  metadata: text("metadata"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Data migrations
// ---------------------------------------------------------------------------

export const oneTimeMigrations = sqliteTable("one_time_migrations", {
  key: text("key").primaryKey(),
  ranAt: integer("ran_at").notNull(),
});

// ---------------------------------------------------------------------------
// Contacts (auth/authz — gateway-owned)
// ---------------------------------------------------------------------------
//
// ACL / INFO SPLIT — see memory/concepts/decision/contact-data-split.md.
//
// The gateway DB owns ONLY the data the ACL needs to answer "can this contact
// do X?". Informational / UX / product data that does NOT affect access
// decisions lives in the assistant DB and is joined at read time via
// `assistantDbQuery` (see contacts-info-joiner.ts).
//
// Gateway-owned (this table + contact_channels): id, role, principalId,
// displayName (cache only — NOT used for ACL, kept for log readability),
// and every contact_channels column (type, address, status, policy,
// verifiedAt, verifiedVia, inviteId, lastSeenAt, interactionCount,
// lastInteraction, revokedReason, blockedReason).
//
// Assistant-owned (DO NOT add here): notes, userFile, contactType,
// assistant_contact_metadata (species + metadata blob). Adding any of these
// to the gateway schema violates the split and will be rejected in review.

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("contact"),
  principalId: text("principal_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const contactChannels = sqliteTable(
  "contact_channels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    address: text("address").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    externalChatId: text("external_chat_id"),
    status: text("status").notNull().default("unverified"),
    policy: text("policy").notNull().default("allow"),
    verifiedAt: integer("verified_at"),
    verifiedVia: text("verified_via"),
    inviteId: text("invite_id"),
    revokedReason: text("revoked_reason"),
    blockedReason: text("blocked_reason"),
    lastSeenAt: integer("last_seen_at"),
    interactionCount: integer("interaction_count").notNull().default(0),
    lastInteraction: integer("last_interaction"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at"),
  },
  (table) => [
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
    ),
    uniqueIndex("idx_contact_channels_type_address_unique").on(
      table.type,
      table.address,
    ),
  ],
);

export const ingressInvites = sqliteTable(
  "ingress_invites",
  {
    id: text("id").primaryKey(),
    sourceChannel: text("source_channel").notNull(),
    // Logically nullable (voice invites carry voiceCodeHash instead), but the
    // NOT NULL constraint must stay: relaxing it (or adding a default) makes
    // drizzle push rebuild the table, and pushSQLiteSchema's generated rebuild
    // corrupts existing DBs (INSERT..SELECT references not-yet-existent
    // columns, duplicated CREATE INDEX statements crash startup). The store
    // writes the "" sentinel for invites without a code (see
    // NO_INVITE_CODE_HASH in contact-store.ts); m0009 owns normalization.
    inviteCodeHash: text("invite_code_hash").notNull(),
    // SHA-256 hash of the one-time invite link token (null for voice invites).
    tokenHash: text("token_hash"),
    // Voice invite fields (null for non-voice invites).
    voiceCodeHash: text("voice_code_hash"),
    voiceCodeDigits: integer("voice_code_digits"),
    expectedExternalUserId: text("expected_external_user_id"),
    // Display metadata for personalized invite prompts.
    friendName: text("friend_name"),
    guardianName: text("guardian_name"),
    // Opaque passthrough — the gateway never interprets it.
    sourceConversationId: text("source_conversation_id"),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("active"),
    redeemedByExternalUserId: text("redeemed_by_external_user_id"),
    redeemedByExternalChatId: text("redeemed_by_external_chat_id"),
    redeemedAt: integer("redeemed_at"),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_ingress_invites_code_lookup").on(
      table.inviteCodeHash,
      table.sourceChannel,
    ),
    index("idx_ingress_invites_contact").on(table.contactId),
    index("idx_ingress_invites_token_hash").on(table.tokenHash),
    index("idx_ingress_invites_expected_user").on(
      table.expectedExternalUserId,
      table.status,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Auto-approve thresholds
// ---------------------------------------------------------------------------

export const autoApproveThresholds = sqliteTable("auto_approve_thresholds", {
  id: integer("id").primaryKey().default(1),
  interactive: text("interactive").notNull().default("medium"),
  autonomous: text("autonomous").notNull().default("low"),
  headless: text("headless").notNull().default("none"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const conversationThresholdOverrides = sqliteTable(
  "conversation_threshold_overrides",
  {
    conversationId: text("conversation_id").primaryKey(),
    threshold: text("threshold").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
);

// ---------------------------------------------------------------------------
// Actor tokens (auth — gateway-owned)
// ---------------------------------------------------------------------------

export const actorTokenRecords = sqliteTable(
  "actor_token_records",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    guardianPrincipalId: text("guardian_principal_id").notNull(),
    hashedDeviceId: text("hashed_device_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_actor_tokens_active_device")
      .on(table.guardianPrincipalId, table.hashedDeviceId)
      .where(sql`status = 'active'`),
    // Unfiltered (not WHERE status='active') so the hot-path revocation lookup
    // — which matches by token_hash and must find REVOKED rows — is indexed.
    index("idx_actor_tokens_hash").on(table.tokenHash),
  ],
);

export const actorRefreshTokenRecords = sqliteTable(
  "actor_refresh_token_records",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    guardianPrincipalId: text("guardian_principal_id").notNull(),
    hashedDeviceId: text("hashed_device_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at").notNull(),
    inactivityExpiresAt: integer("inactivity_expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    browserRefreshCookiePath: text("browser_refresh_cookie_path"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_refresh_tokens_hash").on(table.tokenHash),
    uniqueIndex("idx_refresh_tokens_active_device")
      .on(table.guardianPrincipalId, table.hashedDeviceId)
      .where(sql`status = 'active'`),
    index("idx_refresh_tokens_family").on(table.familyId),
  ],
);

// ---------------------------------------------------------------------------
// Trust rules (v3)
// ---------------------------------------------------------------------------

export const trustRules = sqliteTable(
  "trust_rules",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    pattern: text("pattern").notNull(),
    risk: text("risk").notNull(), // "low" | "medium" | "high"
    description: text("description").notNull(),
    origin: text("origin").notNull(), // "default" | "user_defined"
    userModified: integer("user_modified", { mode: "boolean" })
      .notNull()
      .default(false),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_trust_rules_tool_pattern").on(table.tool, table.pattern),
  ],
);

// ---------------------------------------------------------------------------
// Channel admission policy (per channel type)
// ---------------------------------------------------------------------------

export const channelAdmissionPolicy = sqliteTable("channel_admission_policy", {
  // Channel TYPE — matches `ChannelId` in gateway/src/channels/types.ts.
  // Stored as text rather than an enum because SQLite has no enum type;
  // the app layer validates against CHANNEL_IDS at write time.
  channelType: text("channel_type").primaryKey(),
  // One of: 'no_one' | 'guardian_only' | 'trusted_contacts' |
  //         'any_contact' | 'strangers'. Read-side default lives in the
  //         store (ADMISSION_POLICY_DEFAULT) — absent rows resolve to it.
  policy: text("policy").notNull().default("trusted_contacts"),
  // Optional human note (e.g. "switched to no_one because <reason>").
  note: text("note"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Channel permission overrides (matrix cells: cascade key × contact-type)
// ---------------------------------------------------------------------------

export const channelPermissionOverrides = sqliteTable(
  "channel_permission_overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Cascade level: 'workspace' | 'adapter' | 'channel_type' | 'channel'.
    // Stored as text; the app layer validates against the contract enum at
    // write time (same pattern as channel_admission_policy.policy).
    scope: text("scope").notNull(),
    // Cascade keys. Empty string (not NULL) for keys above the row's scope
    // so the unique index can enforce one row per cell — SQLite treats
    // NULLs as distinct in unique indexes.
    adapter: text("adapter").notNull().default(""),
    channelType: text("channel_type").notNull().default(""),
    channelExternalId: text("channel_external_id").notNull().default(""),
    // Contact-type axis — canonical trust class ('guardian' |
    // 'trusted_contact' | 'unverified_contact' | 'unknown').
    contactType: text("contact_type").notNull(),
    // RiskThreshold: 'none' | 'low' | 'medium' | 'high'.
    threshold: text("threshold").notNull(),
    // Optional human note (e.g. migration provenance).
    note: text("note"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_channel_permission_cell").on(
      table.scope,
      table.adapter,
      table.channelType,
      table.channelExternalId,
      table.contactType,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Guardian verification rate limits
// ---------------------------------------------------------------------------

export const channelGuardianRateLimits = sqliteTable(
  "channel_guardian_rate_limits",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    actorExternalUserId: text("actor_external_user_id").notNull(),
    actorChatId: text("actor_chat_id").notNull(),
    attemptTimestampsJson: text("attempt_timestamps_json")
      .notNull()
      .default("[]"),
    lockedUntil: integer("locked_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_gw_channel_guardian_rate_limits_actor").on(
      table.channel,
      table.actorExternalUserId,
      table.actorChatId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Channel verification sessions (dual-write mirror of assistant table)
// ---------------------------------------------------------------------------

export const channelVerificationSessions = sqliteTable(
  "channel_verification_sessions",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    challengeHash: text("challenge_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    sourceConversationId: text("source_conversation_id"),
    consumedByExternalUserId: text("consumed_by_external_user_id"),
    consumedByChatId: text("consumed_by_chat_id"),
    expectedExternalUserId: text("expected_external_user_id"),
    expectedChatId: text("expected_chat_id"),
    expectedPhoneE164: text("expected_phone_e164"),
    identityBindingStatus: text("identity_binding_status").default("bound"),
    destinationAddress: text("destination_address"),
    lastSentAt: integer("last_sent_at"),
    sendCount: integer("send_count").default(0),
    nextResendAt: integer("next_resend_at"),
    codeDigits: integer("code_digits").default(6),
    maxAttempts: integer("max_attempts").default(3),
    verificationPurpose: text("verification_purpose").default("guardian"),
    bootstrapTokenHash: text("bootstrap_token_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_gw_cvs_channel_status").on(table.channel, table.status),
  ],
);

// ---------------------------------------------------------------------------
// Channel denial reply log (rate-limiting outbound denial replies)
// ---------------------------------------------------------------------------

export const channelDenialReplyLog = sqliteTable(
  "channel_denial_reply_log",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    sourceAddress: text("source_address").notNull(),
    sentAt: integer("sent_at").notNull(),
  },
  (table) => [
    index("idx_channel_denial_source_sent").on(
      table.channel,
      table.sourceAddress,
      table.sentAt,
    ),
    index("idx_channel_denial_sent").on(table.sentAt),
  ],
);
