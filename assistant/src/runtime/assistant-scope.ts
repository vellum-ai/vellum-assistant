/**
 * Canonical internal scope ID for all daemon-side assistant-scoped storage.
 *
 * The daemon uses a single fixed identity (`'self'`) for its own assistant
 * scope. Public/external assistant IDs are an edge concern owned by the
 * gateway and platform layers (hatch, invite links, etc.). Daemon code
 * should never derive scoping decisions from externally-provided assistant
 * IDs — use this constant instead.
 *
 * Multi-instance invariant: each daemon process is single-tenant within
 * its own BASE_DATA_DIR. The fixed "self" value works across multiple
 * local instances because each instance has isolated storage — there is
 * no cross-instance data sharing that would require disambiguating IDs.
 */
export const DAEMON_INTERNAL_ASSISTANT_ID = "self" as const;
