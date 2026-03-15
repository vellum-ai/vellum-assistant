export interface WorkspaceMigration {
  /** Unique identifier, e.g. "001-avatar-rename". Used as the checkpoint key. */
  id: string;
  /** Human-readable description for logging. */
  description: string;
  /** The migration function. Receives the workspace directory path.
   *  Must be idempotent — safe to re-run if it was interrupted. */
  run(workspaceDir: string): void;
}
