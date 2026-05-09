import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { providers } from "./providers.js";

export const rateCards = sqliteTable(
  "rate_cards",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    model: text("model").notNull(),
    inputTokenCostPer1m: real("input_token_cost_per_1m").notNull(),
    outputTokenCostPer1m: real("output_token_cost_per_1m").notNull(),
    cacheWriteCostPer1m: real("cache_write_cost_per_1m"),
    cacheReadCostPer1m: real("cache_read_cost_per_1m"),
    currency: text("currency").notNull().default("USD"),
    effectiveFrom: integer("effective_from").notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    index("idx_rate_cards_provider_model_effective_from").on(
      table.providerId,
      table.model,
      table.effectiveFrom,
    ),
  ],
);
