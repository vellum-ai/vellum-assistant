/**
 * Gateway SQLite schema — Drizzle ORM table declarations.
 *
 * This is the single source of truth for the gateway database schema.
 * Tables are created declaratively via CREATE TABLE IF NOT EXISTS at
 * startup (see connection.ts). Drizzle provides typed query access.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export const slackActiveThreads = sqliteTable("slack_active_threads", {
  threadTs: text("thread_ts").primaryKey(),
  trackedAt: integer("tracked_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const slackSeenEvents = sqliteTable("slack_seen_events", {
  eventId: text("event_id").primaryKey(),
  seenAt: integer("seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
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
