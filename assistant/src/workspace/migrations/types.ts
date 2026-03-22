export interface WorkspaceMigration {
  /** Unique identifier, e.g. "001-avatar-rename". Used as the checkpoint key.
   *  Must be unique across all registered migrations — the runner validates this at startup. */
  id: string;
  /** Human-readable description for logging. */
  description: string;
  /** The migration function. Receives the workspace directory path.
   *  Must be idempotent — safe to re-run if it was interrupted.
   *  Both synchronous and asynchronous migrations are supported. */
  run(workspaceDir: string): void | Promise<void>;
  /** Reverse the migration. Receives the workspace directory path.
   *  Must be idempotent — safe to re-run if it was interrupted.
   *  Both synchronous and asynchronous rollbacks are supported. */
  down(workspaceDir: string): void | Promise<void>;
}
