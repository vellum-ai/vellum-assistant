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
    externalUserId: text("external_user_id"),
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
    index("idx_contact_channels_type_ext_user").on(
      table.type,
      table.externalUserId,
    ),
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
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
    index("idx_actor_tokens_hash")
      .on(table.tokenHash)
      .where(sql`status = 'active'`),
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
