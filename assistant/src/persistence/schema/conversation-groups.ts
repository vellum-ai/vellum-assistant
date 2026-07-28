import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversationGroups = sqliteTable("conversation_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Client-chosen icon name (e.g. a Lucide icon key); null = client default. */
  icon: text("icon"),
  sortPosition: real("sort_position").notNull().default(0),
  isSystemGroup: integer("is_system_group", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
