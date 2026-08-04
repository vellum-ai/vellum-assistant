/**
 * Plugin-declared schedules record their provenance in the `source_key`
 * column as `plugin:<pluginName>/<scheduleName>`. The format is minted by
 * `pluginScheduleSourceKey` in schedule/plugin-schedule-declarations.ts;
 * this leaf parser lets display surfaces (CLI tables, tool output) derive
 * the owning plugin without importing the daemon's schedule modules.
 */

const PLUGIN_SOURCE_KEY_RE = /^plugin:([^/]+)\//;

/**
 * The owning plugin's name from a schedule row's `source_key`, or `null` when
 * the row is imperative (no key) or the key does not match the format.
 */
export function pluginNameFromScheduleSourceKey(
  sourceKey: string | null | undefined,
): string | null {
  if (!sourceKey) {
    return null;
  }
  return PLUGIN_SOURCE_KEY_RE.exec(sourceKey)?.[1] ?? null;
}
