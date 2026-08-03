/**
 * The `PRAGMA optimize` mask run by the daily maintenance sweep and by
 * `db-init` after a boot that applied migrations.
 *
 * Both run on connections with no useful query history, so `0x10000` is what
 * lets optimize look past tables missing from `sqlite_stat1` and reconsider
 * ones whose entries have gone stale. `0x2` keeps the default "analyze where
 * it helps" behavior and `0x10` bounds each ANALYZE with a temporary
 * `analysis_limit`. Releases before 3.46 ignore bits they do not recognize
 * rather than failing, so the mask is safe to send to any version.
 *
 * https://sqlite.org/lang_analyze.html#recommended_usage_patterns
 */
export const PLANNER_OPTIMIZE_PRAGMA = "PRAGMA optimize=0x10012";
