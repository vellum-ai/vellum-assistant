/**
 * Tests for the CLI's migration-aware daemon readiness probe.
 *
 * `/readyz` keeps its HTTP status at 200 while DB migrations run (the k8s
 * contract — the pod must stay in service), so the CLI classifies readiness
 * from the response BODY instead: ready / migrating / failed / unreachable.
 * The `failed` state is terminal for the daemon process, so the polling wait
 * must return immediately instead of burning its full deadline.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  probeDaemonReadiness,
  waitForDaemonMigrationsReady,
} from "../lib/http-client.js";

type ReadyzResponder = () => Response;

let server: ReturnType<typeof Bun.serve> | null = null;

function serveReadyz(responder: ReadyzResponder): number {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/readyz") return responder();
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("probeDaemonReadiness", () => {
  test("classifies the ready body as ready", async () => {
    const port = serveReadyz(() =>
      Response.json({ status: "ok", ready: true }),
    );
    expect(await probeDaemonReadiness(port)).toBe("ready");
  });

  test("classifies a 200 migrating body as migrating", async () => {
    const port = serveReadyz(() =>
      Response.json({
        status: "migrating",
        ready: false,
        dbMigrations: { ready: false, state: "running" },
      }),
    );
    expect(await probeDaemonReadiness(port)).toBe("migrating");
  });

  test("classifies the 503 failed body as failed", async () => {
    const port = serveReadyz(() =>
      Response.json(
        {
          status: "error",
          ready: false,
          reason: "db_migrations_failed",
          dbMigrations: { ready: false, state: "failed" },
        },
        { status: 503 },
      ),
    );
    expect(await probeDaemonReadiness(port)).toBe("failed");
  });

  test("treats a legacy 200 body without a ready field as ready", async () => {
    // Daemons that predate the migration-state body return { status: "ok" }.
    const port = serveReadyz(() => Response.json({ status: "ok" }));
    expect(await probeDaemonReadiness(port)).toBe("ready");
  });

  test("classifies a legacy strict-503 startup body as migrating, not unreachable", async () => {
    // Pre-migration-body daemons return 503 { status, ready, notReady }
    // throughout startup. The daemon ANSWERED, so it is alive — classifying
    // it unreachable would make callers treat a starting daemon as dead.
    const port = serveReadyz(() =>
      Response.json(
        { status: "unready", ready: false, notReady: ["startup", "db"] },
        { status: 503 },
      ),
    );
    expect(await probeDaemonReadiness(port)).toBe("migrating");
  });

  test("reports unreachable when nothing is listening", async () => {
    const port = serveReadyz(() => Response.json({ ready: true }));
    server?.stop(true);
    server = null;
    expect(await probeDaemonReadiness(port)).toBe("unreachable");
  });
});

describe("waitForDaemonMigrationsReady", () => {
  test("returns failed immediately without waiting out the deadline", async () => {
    const port = serveReadyz(() =>
      Response.json(
        {
          status: "error",
          ready: false,
          dbMigrations: { ready: false, state: "failed" },
        },
        { status: 503 },
      ),
    );
    const started = Date.now();
    const readiness = await waitForDaemonMigrationsReady(
      port,
      Date.now() + 60_000,
    );
    expect(readiness).toBe("failed");
    // Terminal state short-circuits: nowhere near the 60s deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("keeps polling through migrating and resolves ready", async () => {
    let calls = 0;
    const port = serveReadyz(() => {
      calls++;
      return calls < 3
        ? Response.json({
            status: "migrating",
            ready: false,
            dbMigrations: { ready: false, state: "running" },
          })
        : Response.json({ status: "ok", ready: true });
    });
    const readiness = await waitForDaemonMigrationsReady(
      port,
      Date.now() + 10_000,
    );
    expect(readiness).toBe("ready");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("returns migrating when the deadline passes mid-migration", async () => {
    const port = serveReadyz(() =>
      Response.json({
        status: "migrating",
        ready: false,
        dbMigrations: { ready: false, state: "running" },
      }),
    );
    const readiness = await waitForDaemonMigrationsReady(
      port,
      Date.now() + 600,
    );
    expect(readiness).toBe("migrating");
  });
});
