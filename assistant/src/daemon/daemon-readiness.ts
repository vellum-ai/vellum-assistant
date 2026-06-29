// Module-level readiness state for the daemon, readable synchronously from any
// request handler with no `await`. Detailed health reports this state, and
// `/readyz` uses it to fail only when DB migrations fail.
//
// CES is intentionally not latched here: it is read live
// (`getCesClient()?.isReady()`) only when reported in a response body, and must
// never gate readiness.

let startupComplete = false;

export type DbMigrationReadiness =
  | { ready: true; state: "ready" }
  | {
      ready: false;
      state: "not_started" | "running" | "failed";
      reason:
        | "db_migrations_not_started"
        | "db_migrations_running"
        | "db_migrations_failed";
      error?: string;
    };

let dbMigrationReadiness: DbMigrationReadiness = {
  ready: true,
  state: "ready",
};

export function setDbReady(v: boolean): void {
  dbMigrationReadiness = v
    ? { ready: true, state: "ready" }
    : {
        ready: false,
        state: "not_started",
        reason: "db_migrations_not_started",
      };
}

export function setDbMigrating(): void {
  dbMigrationReadiness = {
    ready: false,
    state: "running",
    reason: "db_migrations_running",
  };
}

export function setDbMigrationFailed(error?: unknown): void {
  dbMigrationReadiness = {
    ready: false,
    state: "failed",
    reason: "db_migrations_failed",
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

export function getDbMigrationReadiness(): DbMigrationReadiness {
  return dbMigrationReadiness;
}

export function isDbReady(): boolean {
  return dbMigrationReadiness.ready;
}

// One-way latch: once startup completes it stays complete for the process
// lifetime.
export function setStartupComplete(): void {
  startupComplete = true;
}

export function isStartupComplete(): boolean {
  return startupComplete;
}

export function resetReadinessForTest(): void {
  setDbReady(true);
  startupComplete = false;
}
