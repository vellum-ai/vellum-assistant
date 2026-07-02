import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  userFile: text("user_file"), // workspace-relative path to per-user persona file
  contactType: text("contact_type", { enum: ["human", "assistant"] })
    .notNull()
    .default("human"),
});

export const contactChannels = sqliteTable(
  "contact_channels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'email', 'slack', 'whatsapp', 'phone', etc.
    address: text("address").notNull(), // the actual identifier on that channel
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    externalChatId: text("external_chat_id"), // delivery/notification routing address (e.g., Telegram chat ID)
    inviteId: text("invite_id"), // reference to invite that onboarded
    lastSeenAt: integer("last_seen_at"), // epoch ms
    interactionCount: integer("interaction_count").notNull().default(0),
    lastInteraction: integer("last_interaction"),
    updatedAt: integer("updated_at"), // epoch ms
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
    ),
  ],
);

export const assistantContactMetadata = sqliteTable(
  "assistant_contact_metadata",
  {
    contactId: text("contact_id")
      .primaryKey()
      .references(() => contacts.id, { onDelete: "cascade" }),
    species: text("species").notNull(), // 'vellum' | 'openclaw'
    metadata: text("metadata"), // JSON blob for species-specific fields
  },
);

export const assistantIngressInvites = sqliteTable(
  "assistant_ingress_invites",
  {
    id: text("id").primaryKey(),
    sourceChannel: text("source_channel").notNull(),
    tokenHash: text("token_hash").notNull(),
    sourceConversationId: text("source_conversation_id"),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("active"),
    redeemedByExternalUserId: text("redeemed_by_external_user_id"),
    redeemedByExternalChatId: text("redeemed_by_external_chat_id"),
    redeemedAt: integer("redeemed_at"),
    // Voice invite fields (nullable — non-voice invites leave these NULL)
    expectedExternalUserId: text("expected_external_user_id"),
    voiceCodeHash: text("voice_code_hash"),
    voiceCodeDigits: integer("voice_code_digits"),
    // 6-digit invite code hash (nullable — voice invites use voiceCodeHash instead)
    inviteCodeHash: text("invite_code_hash"),
    // Display metadata for personalized voice prompts (nullable — non-voice invites leave these NULL)
    friendName: text("friend_name"),
    guardianName: text("guardian_name"),
    contactId: text("contact_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);
