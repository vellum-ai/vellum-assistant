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
});
