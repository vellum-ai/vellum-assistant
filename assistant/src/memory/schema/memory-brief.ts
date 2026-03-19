import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Time contexts represent bounded temporal windows that are relevant to the
 * assistant's current awareness — e.g. "user is traveling next week",
 * "quarterly planning period ends Friday".  Each row captures one window
 * with an activation range and a human-readable summary the brief can surface.
 */
export const timeContexts = sqliteTable(
  "time_contexts",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    summary: text("summary").notNull(),
    source: text("source").notNull(), // e.g. 'conversation', 'schedule', 'manual'
    activeFrom: integer("active_from").notNull(), // epoch ms — window start
    activeUntil: integer("active_until").notNull(), // epoch ms — window end
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_time_contexts_scope_active_until").on(
      table.scopeId,
      table.activeUntil,
    ),
  ],
);

/**
 * Open loops track unresolved items the assistant should follow up on —
 * e.g. "waiting for Bob's reply", "need to file taxes before April 15".
 * Each row carries a status and an optional due date so the brief can
 * prioritise which loops to surface.
 */
export const openLoops = sqliteTable(
  "open_loops",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull().default("open"), // 'open' | 'resolved' | 'expired'
    source: text("source").notNull(), // e.g. 'conversation', 'followup', 'manual'
    dueAt: integer("due_at"), // epoch ms — optional deadline
    surfacedAt: integer("surfaced_at"), // epoch ms — last time shown in brief
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_open_loops_scope_status_due").on(
      table.scopeId,
      table.status,
      table.dueAt,
    ),
  ],
);
