import { getDb } from "../memory/db.js";

/**
 * Open the SQLite database for CLI commands without running migrations.
 *
 * CLI tools only need a database handle — migration execution is a daemon
 * startup concern (see `initializeDb` in memory/db-init.ts). Running the full
 * migration stack on every CLI invocation is wasteful and produces spurious
 * warnings when the CLI binary version doesn't match the daemon that last
 * migrated the database (e.g., warm-pool pods in vembda).
 */
export function connectDb(): void {
  getDb();
}
