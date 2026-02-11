import {
  boolean,
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Assistants table (formerly agents)
export const assistantsTable = pgTable("assistants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  configuration: jsonb("configuration").default({}),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Assistant channel accounts (Telegram, future channels)
export const assistantChannelAccountsTable = pgTable(
  "assistant_channel_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assistantId: uuid("assistant_id")
      .notNull()
      .references(() => assistantsTable.id, { onDelete: "cascade" }),
    channel: varchar("channel", { length: 50 }).notNull(),
    accountKey: varchar("account_key", { length: 100 }).notNull().default("default"),
    enabled: boolean("enabled").notNull().default(true),
    status: varchar("status", { length: 30 }).notNull().default("inactive"),
    config: jsonb("config").notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_assistant_channel_accounts_assistant_id").on(table.assistantId),
    index("idx_assistant_channel_accounts_channel").on(table.channel),
    uniqueIndex("uniq_assistant_channel_accounts").on(
      table.assistantId,
      table.channel,
      table.accountKey
    ),
  ]
);

// Channel contacts for pairing/allowlist policy
export const assistantChannelContactsTable = pgTable(
  "assistant_channel_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assistantChannelAccountId: uuid("assistant_channel_account_id")
      .notNull()
      .references(() => assistantChannelAccountsTable.id, { onDelete: "cascade" }),
    externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
    externalChatId: varchar("external_chat_id", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }),
    displayName: varchar("display_name", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    lastPairingPromptAt: timestamp("last_pairing_prompt_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_assistant_channel_contacts_account_id").on(table.assistantChannelAccountId),
    index("idx_assistant_channel_contacts_status").on(table.status),
    uniqueIndex("uniq_assistant_channel_contact_user").on(
      table.assistantChannelAccountId,
      table.externalUserId
    ),
  ]
);

// Better Auth: user table
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    username: text("username").unique(),
    displayUsername: text("display_username"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
  },
  (table) => [
    index("idx_user_email").on(table.email),
    index("idx_user_username").on(table.username),
  ]
);

// Better Auth: session table
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("idx_session_user_id").on(table.userId),
    index("idx_session_token").on(table.token),
  ]
);

// Better Auth: account table
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_account_user_id").on(table.userId),
  ]
);

// Better Auth: verification table
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  }
);

// Assistant auth tokens (hashed bearer tokens for assistant-initiated routes)
export const assistantAuthTokensTable = pgTable(
  "assistant_auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assistantId: uuid("assistant_id")
      .notNull()
      .references(() => assistantsTable.id, { onDelete: "cascade" }),
    tokenPrefix: varchar("token_prefix", { length: 8 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scopes: jsonb("scopes").default([]),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_assistant_auth_tokens_assistant_id").on(table.assistantId),
    index("idx_assistant_auth_tokens_token_prefix").on(table.tokenPrefix),
  ]
);

// API Keys table
export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 8 }).notNull(),
    keyHash: varchar("key_hash", { length: 255 }).notNull(),
    scopes: jsonb("scopes").default({ actions: ["read"], entities: ["assistants"], assistant_ids: ["*"] }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_api_keys_user_id").on(table.userId),
    index("idx_api_keys_key_prefix").on(table.keyPrefix),
  ]
);
