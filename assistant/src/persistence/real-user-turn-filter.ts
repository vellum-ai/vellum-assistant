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
  return sql.raw(realUserTurnContentFilterSql(alias));
}

/**
 * Raw-string form of {@link realUserTurnContentFilter}, for queries built as
 * plain SQL template strings (`rawAll` sites). Same fragment, one source.
 *
 * `finalized = 1`: the grouped tool-result row is a USER-role row reserved
 * in-flight (`ensureToolResultRowReserved`), and while it streams its content
 * is a `{ ref }` pointer that does not contain the tool_result text the
 * exclusions match. Without this predicate it counts as a real user turn
 * mid-tool-execution and stops counting once the content folds inline.
 *
 * Bare `[]` content is deliberately NOT excluded: a hidden send persists its
 * user row with empty display content (`processMessage` with
 * `displayContent: ""`) and still runs a turn, so `[]` rows are legitimate
 * turns. The cost is a narrow pre-existing window in the writer-creation
 * fallback, where the tool-result row is born finalized with a `[]`
 * placeholder and counts until the first content write lands; that window is
 * rare (writer creation failure only) and transient, and closing it needs a
 * signal that distinguishes the placeholder from a real empty-display turn.
 */
export function realUserTurnContentFilterSql(alias: string): string {
  return (
    `${alias}.finalized = 1 ` +
    `AND ${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
    `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`
  );
}
