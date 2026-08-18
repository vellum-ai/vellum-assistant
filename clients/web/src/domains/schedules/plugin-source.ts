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

const DISARM_REASON_KEYS = {
  user_disabled: "scheduleDisarmReason.userDisabled",
  plugin_removed: "scheduleDisarmReason.pluginRemoved",
  plugin_disabled: "scheduleDisarmReason.pluginDisabled",
  declaration_removed: "scheduleDisarmReason.declarationRemoved",
  declaration_disabled: "scheduleDisarmReason.declarationDisabled",
} as const;

type DisarmReasonKey =
  (typeof DISARM_REASON_KEYS)[keyof typeof DISARM_REASON_KEYS];

/**
 * Schedules-namespace key naming why a schedule is off, or null when there is
 * nothing to say: the schedule is on, it is user-created, or the daemon
 * predates the field.
 */
export function disarmReasonLabelKey(schedule: {
  enabled: boolean;
  disarmReason?: string | null;
}): DisarmReasonKey | null {
  if (schedule.enabled || !schedule.disarmReason) {
    return null;
  }
  return (
    DISARM_REASON_KEYS[
      schedule.disarmReason as keyof typeof DISARM_REASON_KEYS
    ] ?? null
  );
}
