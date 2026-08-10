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
 * The fragment also requires `finalized = 1`. The grouped tool-result row is
 * a USER-role row reserved in-flight (`ensureToolResultRowReserved`), and
 * while it streams its content is a `{ ref }` pointer that does not contain
 * the tool_result text the exclusions match, so without the completeness
 * predicate it would count as a real user turn mid-tool-execution and stop
 * counting once finalized. Requiring finalized rows makes the exclusion see
 * the content it is matching against.
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
 * The `!= '[]'` clause covers the writer-creation fallback: a grouped
 * tool-result row reserved without an in-flight writer is born finalized with
 * placeholder `[]` content, which matches neither NOT LIKE exclusion until
 * the first content write lands. A real user turn never persists as a bare
 * empty array, so excluding it drops only placeholders.
 */
export function realUserTurnContentFilterSql(alias: string): string {
  return (
    `${alias}.finalized = 1 ` +
    `AND ${alias}.content != '[]' ` +
    `AND ${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
    `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`
  );
}
