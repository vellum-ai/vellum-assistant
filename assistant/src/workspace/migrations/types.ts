/** Runtime context passed to each migration's `run()`.
 *  Lets seeding migrations distinguish a brand-new workspace from a workspace
 *  upgrading through this migration for the first time. */
export interface MigrationRunContext {
  /** True when no workspace-migration checkpoint file existed at the start of
   *  this run — i.e., this is a freshly-created workspace, not an upgrade. */
  isNewWorkspace: boolean;
}

export interface WorkspaceMigration {
  /** Unique identifier, e.g. "001-avatar-rename". Used as the checkpoint key.
   *  Must be unique across all registered migrations — the runner validates this at startup. */
  id: string;
  /** Human-readable description for logging. */
  description: string;
  /** The migration function. Receives the workspace directory path and an
   *  optional context object (always supplied by the runner; tests may omit
   *  it). Must be idempotent — safe to re-run if it was interrupted.
   *  Both synchronous and asynchronous migrations are supported. */
  run(workspaceDir: string, ctx?: MigrationRunContext): void | Promise<void>;
  /** Reverse the migration. Receives the workspace directory path.
   *  Must be idempotent — safe to re-run if it was interrupted.
   *  Both synchronous and asynchronous rollbacks are supported. */
  down(workspaceDir: string): void | Promise<void>;
}

/** Checkpoint status values for workspace migration tracking. */
export type WorkspaceMigrationStatus =
  | "started"
  | "completed"
  | "rolling_back"
  | "failed";
