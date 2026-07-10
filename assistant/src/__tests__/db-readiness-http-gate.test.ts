import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  setDbMigrating,
  setDbMigrationFailed,
  setDbReady,
} from "../daemon/daemon-readiness.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { APP_VERSION } from "../version.js";

describe("DB migration readiness HTTP gate", () => {
  let server: RuntimeHttpServer | null = null;
  let port = 0;

  beforeEach(() => {
    setDbReady(true);
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    setDbReady(true);
  });

  test("returns 503 for DB-backed API routes while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("db_migrations_running");
  });

  test("continues serving detailed health while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(url("/health"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("MIGRATING");
    expect(body.reason).toBe("db_migrations_running");
    expect((body.dbMigrations as Record<string, unknown>).state).toBe(
      "running",
    );
  });

  test("continues serving healthz while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", version: APP_VERSION });
  });

  test("continues serving readyz while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    // 200 keeps the k8s pod in service; the body reports the real state.
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("migrating");
    expect(body.ready).toBe(false);
    expect((body.dbMigrations as Record<string, unknown>).state).toBe(
      "running",
    );
  });

  test("allows the migration-repair surface only in the failed state", async () => {
    // While migrations RUN, rollback stays gated (it would race the runner).
    setDbMigrating();
    await startServer();

    let response = await fetch(url("/admin/rollback-migrations"), {
      method: "POST",
    });
    expect(response.status).toBe(503);
    let body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe("db_migrations_running");

    // In the terminal FAILED state the repair surface passes the migration
    // gate (the request proceeds to auth — anything but the gate's 503 body).
    setDbMigrationFailed(new Error("boom"));
    response = await fetch(url("/admin/rollback-migrations"), {
      method: "POST",
    });
    body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.reason).not.toBe("db_migrations_failed");

    // The parameterized job-status route (GCS import polling) passes the
    // gate by prefix in the failed state.
    response = await fetch(url("/migrations/jobs/some-job-id"));
    body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.reason).not.toBe("db_migrations_failed");

    // Non-repair routes stay gated in the failed state.
    response = await fetch(url("/conversations"));
    expect(response.status).toBe(503);
    body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe("db_migrations_failed");
  });

  test("blocks config schema while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(url("/config/schema"));
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("db_migrations_running");
  });

  test("returns 503 for Twilio webhooks before validation while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(url("/calls/twilio/voice-webhook"), {
      method: "POST",
    });
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("db_migrations_running");
  });

  test("returns 503 for shared pages while migrations are running", async () => {
    setDbMigrating();
    await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/pages/app-123`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("db_migrations_running");
  });

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({ port: await getFreePort() });
    await server.start();
    port = server.actualPort;
  }

  function url(pathname: string): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${port}/v1${pathname}`;
  }
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate free port"));
        }
      });
    });
  });
}
