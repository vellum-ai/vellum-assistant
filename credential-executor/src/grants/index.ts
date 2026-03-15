/**
 * CES grant stores.
 *
 * Re-exports the persistent and temporary grant stores used by the
 * Credential Execution Service to track user approval decisions.
 *
 * - **Persistent store**: Durable grants (e.g. `always_allow`) persisted
 *   to `grants.json` inside the CES-private data root. Survives restarts.
 * - **Temporary store**: Ephemeral grants (`allow_once`, `allow_10m`,
 *   `allow_thread`) held in memory. Never survives a process restart.
 */

export { PersistentGrantStore } from "./persistent-store.js";
export type { PersistentGrant } from "./persistent-store.js";

export { TemporaryGrantStore } from "./temporary-store.js";
export type { TemporaryGrant, TemporaryGrantKind } from "./temporary-store.js";
