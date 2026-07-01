import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversationGroups = sqliteTable("conversation_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sortPosition: real("sort_position").notNull().default(0),
  isSystemGroup: integer("is_system_group", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
