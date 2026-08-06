/**
 * Provenance of a deferred-wake schedule row, recorded in `createdBy`.
 *
 * A wake firing resumes an existing conversation unattended and can recover
 * that conversation's resting trust, so it needs durable proof that the row's
 * target and trigger text were chosen by the assistant's owner. `createdBy` is
 * the field that can carry that proof: it is set once at creation and appears
 * in no update path (`updateSchedule` does not accept it, so no route, tool, or
 * CLI command can rewrite it).
 *
 * The value is versioned rather than reused because rows written before the
 * proof existed cannot be told apart from rows that were retargeted while the
 * update surface still allowed it. Legacy rows keep working as schedules and
 * keep their place in the defer UI; they simply never recover trust.
 */

/**
 * Defers written before owner provenance was recorded. Functional, but carries
 * no proof of who chose its target, so it never recovers resting trust.
 */
export const LEGACY_DEFER_CREATED_BY = "defer";

/**
 * Defers created through the defer surface by a verified owner (a local IPC
 * caller, or the current bound guardian). Only this value can recover trust.
 */
export const OWNER_DEFER_CREATED_BY = "defer:owner";

/** Every value that marks a row as a deferred wake, for listing and filtering. */
export const DEFER_CREATED_BY_VALUES: readonly string[] = [
  LEGACY_DEFER_CREATED_BY,
  OWNER_DEFER_CREATED_BY,
];

/**
 * Whether the row is a deferred wake at all. Use for presentation concerns
 * (hiding defers from the schedule list, naming, defer list/cancel scoping),
 * never to decide trust.
 */
export function isDeferSchedule(createdBy: string): boolean {
  return DEFER_CREATED_BY_VALUES.includes(createdBy);
}

/**
 * Whether the row carries durable proof that an owner chose its wake target and
 * trigger text. This is the only defer-provenance question that may feed a
 * trust decision.
 */
export function hasOwnerDeferProvenance(createdBy: string): boolean {
  return createdBy === OWNER_DEFER_CREATED_BY;
}
