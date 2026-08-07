/**
 * Plugin-sourced schedules carry a `sourceKey` of the form
 * `plugin:<pluginName>/<scheduleName>`. Their definition is edited via the
 * plugin's schedule files; the only user mutation the UI offers is the
 * enabled toggle (persisted server-side as `userEnabled`).
 */

/**
 * Plugin name embedded in a schedule's source key; null for user-created
 * schedules, unrecognized keys, and daemons that predate the field.
 */
export function pluginNameFromSourceKey(
  sourceKey: string | null | undefined,
): string | null {
  const match = /^plugin:([^/]+)\//.exec(sourceKey ?? "");
  return match?.[1] ?? null;
}
