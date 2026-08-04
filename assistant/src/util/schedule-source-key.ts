/**
 * Plugin-declared schedules record their provenance in the `source_key`
 * column as `plugin:<pluginName>/<scheduleName>`. The format is minted by
 * `pluginScheduleSourceKey` in schedule/plugin-schedule-declarations.ts;
 * this leaf parser lets display surfaces (CLI tables, tool output) derive
 * the owning plugin without importing the daemon's schedule modules.
 */

const PLUGIN_SOURCE_KEY_RE = /^plugin:([^/]+)\//;

/**
 * Display attribution for a schedule row: the owning plugin's name, the raw
 * key when it does not match the format so provenance is never silently
 * dropped, or null when the row is imperative.
 */
export function describeScheduleSource(
  sourceKey: string | null | undefined,
): string | null {
  if (!sourceKey) {
    return null;
  }
  return PLUGIN_SOURCE_KEY_RE.exec(sourceKey)?.[1] ?? sourceKey;
}
