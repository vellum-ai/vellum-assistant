/**
 * Unit tests for the IPC transport's DB migration readiness gate.
 *
 * Migrations run asynchronously during daemon startup, so the IPC server can be
 * answering before the schema exists. ORM-touching methods must be refused with
 * a retryable 503 while migrations run/fail; exempt methods (health/healthz/ps/
 * $cancel) must stay answerable so the gateway can poll `health` to observe
 * readiness (see gateway/src/post-assistant-ready.ts). This mirrors the HTTP
 * gate covered by src/__tests__/db-readiness-http-gate.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  setDbMigrating,
  setDbMigrationFailed,
  setDbReady,
} from "../../daemon/daemon-readiness.js";
import { AssistantIpcServer, type IpcResponse } from "../assistant-server.js";

/**
 * `dbMigrationGateResponse` is private; access it through an interface cast so
 * the test exercises the real production path without exporting a test-only API
 * (same pattern as route-error-envelope.test.ts).
 */
type PrivateApi = {
  dbMigrationGateResponse(method: string, id: string): IpcResponse | null;
};

function gate(method: string): IpcResponse | null {
  const server = new AssistantIpcServer() as unknown as PrivateApi;
  return server.dbMigrationGateResponse(method, "req-1");
}

describe("AssistantIpcServer DB migration readiness gate", () => {
  afterEach(() => {
    // Readiness is process-global module state; restore the ready default so it
    // does not leak into other tests.
    setDbReady(true);
  });

  test("refuses ORM-touching methods with a retryable 503 while migrating", () => {
    setDbMigrating();
    const response = gate("db_proxy");

    expect(response).not.toBeNull();
    expect(response?.id).toBe("req-1");
    expect(response?.statusCode).toBe(503);
    expect(response?.errorCode).toBe("DB_MIGRATIONS_UNAVAILABLE");
    expect(response?.error).toContain("running");
    expect(response?.errorDetails).toMatchObject({
      ready: false,
      state: "running",
    });
  });

  test("refuses ORM-touching methods when migrations have failed", () => {
    setDbMigrationFailed(new Error("boom"));
    const response = gate("get_conversations");

    expect(response?.statusCode).toBe(503);
    expect(response?.errorCode).toBe("DB_MIGRATIONS_UNAVAILABLE");
    expect(response?.errorDetails).toMatchObject({
      ready: false,
      state: "failed",
    });
  });

  test("allows all methods once migrations are ready", () => {
    setDbReady(true);
    expect(gate("db_proxy")).toBeNull();
    expect(gate("get_conversations")).toBeNull();
  });

  test("exempt methods stay answerable while migrating", () => {
    setDbMigrating();
    // health/healthz let the gateway observe readiness; $cancel/ps never read
    // the DB. All must bypass the gate even mid-migration.
    for (const method of ["health", "healthz", "ps", "$cancel"]) {
      expect(gate(method)).toBeNull();
    }
  });

  test("migration-repair surface is allowed only in the failed state", () => {
    // Rollback/import are the remedies for failed migrations — gating them in
    // that state would make recovery impossible (the upgrade CLI's
    // rollback/restore path). While migrations are merely RUNNING they stay
    // gated: a rollback would race the in-flight migration runner.
    setDbMigrating();
    expect(gate("admin_rollbackmigrations_post")?.statusCode).toBe(503);
    expect(gate("migrations_import_post")?.statusCode).toBe(503);

    setDbMigrationFailed(new Error("boom"));
    expect(gate("admin_rollbackmigrations_post")).toBeNull();
    expect(gate("migrations_import_post")).toBeNull();
    // All restore transports are repair-capable: preflights, the managed
    // platform's GCS path, and its job-status polling.
    expect(gate("migrations_importpreflight_post")).toBeNull();
    expect(gate("migrations_importfromgcs_post")).toBeNull();
    expect(gate("migrations_preflightfromgcs_post")).toBeNull();
    expect(gate("migrations_jobs_by_job_id_get")).toBeNull();
    // Everything else stays gated in the failed state.
    expect(gate("db_proxy")?.statusCode).toBe(503);
  });
});
