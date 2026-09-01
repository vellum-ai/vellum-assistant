/**
 * Shared bound on a companion-surface entrypoint id.
 *
 * This constant lives in the lowest shared layer because two sides that do not
 * depend on each other have to agree on it: the assistant composes the
 * namespaced id (`<pluginId>:<entrypointId>`) when it lists plugins, and
 * `@vellumai/ipc-contract`'s `companionEntrypointSchema` validates the whole
 * context snapshot against this cap before the surface is updated. Validation
 * is all-or-nothing on that snapshot, so a single over-long id would drop
 * every entrypoint rather than its own; the composing side has to enforce the
 * same number the validating side checks.
 *
 * 128 is generous next to the ~40 characters a plugin may declare for its own
 * half of the id: it is a bound on what crosses the boundary, not a budget the
 * surface draws against.
 */
export const COMPANION_ENTRYPOINT_ID_MAX_LENGTH = 128;
