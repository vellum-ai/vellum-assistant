import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

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

import { setDbMigrating, setDbReady } from "../daemon/daemon-readiness.js";
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
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", ready: true });
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
    server = new RuntimeHttpServer({ port: 0 });
    await server.start();
    port = server.actualPort;
  }

  function url(pathname: string): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${port}/v1${pathname}`;
  }
});
