export type DbMigrationReadiness =
  | {
      ready: true;
      state: "ready";
    }
  | {
      ready: false;
      state: "not_started" | "running" | "failed";
      reason:
        | "db_migrations_not_started"
        | "db_migrations_running"
        | "db_migrations_failed";
      error?: string;
    };

let readiness: DbMigrationReadiness = { ready: true, state: "ready" };

export function getDbMigrationReadiness(): DbMigrationReadiness {
  return readiness;
}

export function markDbMigrationsRunning(): void {
  readiness = {
    ready: false,
    state: "running",
    reason: "db_migrations_running",
  };
}

export function markDbMigrationsReady(): void {
  readiness = { ready: true, state: "ready" };
}

export function markDbMigrationsFailed(error: unknown): void {
  readiness = {
    ready: false,
    state: "failed",
    reason: "db_migrations_failed",
    error: error instanceof Error ? error.message : String(error),
  };
}
