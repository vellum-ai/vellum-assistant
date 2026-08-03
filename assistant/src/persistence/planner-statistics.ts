/**
 * The `PRAGMA optimize` mask both planner-statistics call sites run: the daily
 * maintenance sweep and the post-migration refresh in `db-init`.
 *
 * `0x10000` makes optimize examine every table rather than only those the
 * current connection has queried. Both call sites run on connections with no
 * meaningful query history, so without it optimize considers only tables
 * missing from `sqlite_stat1` and leaves every existing entry frozen at
 * whatever size it was first analyzed at. `0x2` keeps the default "analyze
 * where it would help" behavior, and `0x10` bounds each ANALYZE with a
 * temporary `analysis_limit` so scan cost stays flat regardless of table size.
 *
 * SQLite releases before 3.46 do not implement `0x10000`; they ignore the
 * unrecognized bits and fall back to their existing behavior rather than
 * failing, so the mask is safe to send to any version.
 */
export const PLANNER_OPTIMIZE_PRAGMA = "PRAGMA optimize=0x10012";
