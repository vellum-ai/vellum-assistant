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

/**
 * Operations that must stay answerable while DB migrations are not ready:
 * health/liveness probes and process diagnostics that never touch the ORM.
 *
 * Single source of truth for both transports' migration gates — the HTTP gate
 * (`runtime/http-server.ts`) uses it directly as its exempt endpoint set, and
 * the IPC gate (`ipc/assistant-server.ts`) derives its exempt method set from
 * it (adding the DB-free `$cancel` control method). `health`/`healthz` must
 * remain exempt so the gateway can poll them to observe when migrations
 * finish (see gateway/src/post-assistant-ready.ts).
 */
export const DB_MIGRATION_READINESS_EXEMPT_OPERATIONS: ReadonlySet<string> =
  new Set(["health", "healthz", "ps"]);

/**
 * The migration-repair surface: operations additionally allowed while DB
 * migrations are in the terminal FAILED state — and only then, never while
 * they are still running. Rolling back migrations and importing a backup are
 * exactly the remedies for a failed migration (the upgrade CLI's
 * rollback/restore path), so gating them in that state would make recovery
 * impossible. Contains both the HTTP endpoint form and the IPC operationId
 * form of each route. Bypasses only the migration gate — route policies
 * (gateway-principal scopes, guardian auth) still apply.
 */
export const DB_MIGRATION_FAILED_STATE_EXEMPT_OPERATIONS: ReadonlySet<string> =
  new Set([
    "admin/rollback-migrations",
    "admin_rollbackmigrations_post",
    "migrations/import",
    "migrations_import_post",
    // Restore has three transports; all must stay repair-capable. The
    // preflights are read-only analysis; the GCS import is the managed
    // platform's restore path and is job-based, so its job-status GET (a
    // parameterized route, matched by prefix in isDbMigrationGateBypassed)
    // must answer too.
    "migrations/import-preflight",
    "migrations_importpreflight_post",
    "migrations/import-from-gcs",
    "migrations_importfromgcs_post",
    "migrations/preflight-from-gcs",
    "migrations_preflightfromgcs_post",
    "migrations_jobs_by_job_id_get",
  ]);

/**
 * Whether an operation may proceed despite unready DB migrations: always for
 * the probe/diagnostic exempt set, and additionally for the migration-repair
 * surface when migrations have terminally failed.
 */
export function isDbMigrationGateBypassed(operation: string): boolean {
  if (DB_MIGRATION_READINESS_EXEMPT_OPERATIONS.has(operation)) {
    return true;
  }
  if (dbMigrationReadiness.state !== "failed") {
    return false;
  }
  // The HTTP gate passes the raw path after /v1/, so the parameterized
  // job-status route (migrations/jobs/:job_id) is matched by prefix; the
  // IPC form is the exact operationId in the set above.
  return (
    DB_MIGRATION_FAILED_STATE_EXEMPT_OPERATIONS.has(operation) ||
    operation.startsWith("migrations/jobs/")
  );
}

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
