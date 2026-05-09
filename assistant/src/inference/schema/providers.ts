import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    displayName: text("display_name"),
    contract: text("contract").notNull(),
    baseUrl: text("base_url").notNull(),
    auth: text("auth").notNull(),
    isCanonical: integer("is_canonical", { mode: "boolean" })
      .notNull()
      .default(false),
    canonicalRevision: integer("canonical_revision"),
    canonicalEquivalentId: text("canonical_equivalent_id").references(
      (): AnySQLiteColumn => providers.id,
    ),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    modality: text("modality").notNull().default("chat"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_providers_canonical_equivalent_id").on(
      table.canonicalEquivalentId,
    ),
    index("idx_providers_is_canonical").on(table.isCanonical),
  ],
);

export const ProviderAuthApiKey = z.object({
  type: z.literal("api_key"),
  credential_name: z.string(),
});

export const ProviderAuthPlatform = z.object({
  type: z.literal("platform"),
});

export const ProviderAuthNone = z.object({
  type: z.literal("none"),
});

export const ProviderAuth = z.discriminatedUnion("type", [
  ProviderAuthApiKey,
  ProviderAuthPlatform,
  ProviderAuthNone,
]);

export type ProviderAuth = z.infer<typeof ProviderAuth>;
