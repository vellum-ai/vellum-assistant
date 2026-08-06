import { sql } from "drizzle-orm";

/**
 * SQL fragment that excludes tool-result rows persisted with role="user" —
 * these are system-generated and must not count as user turns.
 *
 * Single source of truth for the "real user turn" notion shared by the
 * turn-event eligibility predicate, the `turn_index` / `parent_turn_index`
 * correlated counts (llm-usage-store), and the turn-trace window. If any
 * copy drifted, a turn index could disagree with the visible turn stream
 * and break "first turn" / "turns per conversation" / parent-attribution
 * math.
 *
 * `alias` is interpolated as the SQL identifier for the table whose
 * `content` column is filtered (e.g. `messages` for an outer query, `m2`
 * for a correlated subquery). ESCAPE '\\' makes the underscores match
 * literally rather than as single-character wildcards.
 */
export function realUserTurnContentFilter(
  alias: string,
): ReturnType<typeof sql> {
  return sql.raw(
    `${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
      `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`,
  );
}
