import type { SecureKeyBackend } from "@vellumai/credential-storage";

/**
 * A single CES data migration.
 *
 * Migrations run at CES startup — once per installation, tracked via a
 * checkpoint file in the CES-private data root. They are the right place
 * for one-time transformations of the credential store (key renames,
 * format changes, etc.) that must happen before the RPC server accepts
 * connections.
 *
 * **Idempotency**: `run` and `down` must both be safe to re-run. The
 * runner re-executes any migration whose checkpoint was left in `"started"`
 * state (i.e. the process crashed mid-migration).
 *
 * **Ordering**: Migrations are executed in registry order. Never reorder
 * or remove an entry from the registry once it has been released.
 */
export interface CesMigration {
  /**
   * Unique identifier used as the checkpoint key.
   * Convention: `"NNN-short-description"`, e.g. `"001-no-op"`.
   * Must be unique across all registered migrations.
   */
  id: string;

  /** Human-readable description logged when the migration runs. */
  description: string;

  /**
   * Apply the migration.
   *
   * Receives the active `SecureKeyBackend` so the migration can read,
   * write, and delete credential store entries without re-opening the
   * encrypted store.
   */
  run(backend: SecureKeyBackend): void | Promise<void>;

  /**
   * Reverse the migration (best-effort).
   *
   * Some migrations are forward-only (e.g. dropping a key that is no
   * longer used). In those cases, implement `down` as a no-op and document
   * why reversal is not meaningful.
   */
  down(backend: SecureKeyBackend): void | Promise<void>;
}

/** Checkpoint status values written to `.ces-migrations.json`. */
export type CesMigrationStatus =
  | "started"
  | "completed"
  | "rolling_back"
  | "failed";
