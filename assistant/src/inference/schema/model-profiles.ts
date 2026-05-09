import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { providers } from "./providers.js";

export const modelProfiles = sqliteTable(
  "model_profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt"),
    temperature: real("temperature"),
    maxTokens: integer("max_tokens"),
    isCanonical: integer("is_canonical", { mode: "boolean" })
      .notNull()
      .default(false),
    canonicalRevision: integer("canonical_revision"),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_model_profiles_provider_id").on(table.providerId),
  ],
);
