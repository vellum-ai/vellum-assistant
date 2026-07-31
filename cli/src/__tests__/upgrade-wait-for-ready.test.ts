/**
 * Tests for the docker upgrade/rollback readiness gate.
 *
 * `waitForReady` classifies readiness from the gateway `/readyz` BODY, not
 * the status code: the forwarded assistant body is 200 with `ready: false`
 * while DB migrations run (the k8s keep-the-pod contract) and while the
 * gateway's own startup gate is closed. Simplifying this back to
 * `if (resp.ok) return true` would make `vellum upgrade` commit and report
 * success mid-migration and make the rollback/restore path unreachable —
 * these tests pin the body semantics.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { waitForReady } from "../lib/upgrade-lifecycle.js";

type ReadyzResponder = () => Response;

let server: ReturnType<typeof Bun.serve> | null = null;

function serveReadyz(responder: ReadyzResponder): string {
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
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("waitForReady", () => {
  test("returns true when the stack reports ready", async () => {
    const url = serveReadyz(() => Response.json({ status: "ok", ready: true }));
    expect(await waitForReady(url)).toBe(true);
  });

  test("does NOT return true on a bare 200 while migrations run", async () => {
    // 200 { ready: false } is the migrating body — resp.ok alone must not
    // count as ready. The responder flips to ready after a few polls so the
    // test proves waitForReady kept waiting rather than returning early.
    let polls = 0;
    const url = serveReadyz(() => {
      polls++;
      return polls < 3
        ? Response.json({
            status: "migrating",
            ready: false,
            dbMigrations: { ready: false, state: "running" },
          })
        : Response.json({ status: "ok", ready: true });
    });

    expect(await waitForReady(url)).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("keeps waiting through the gateway's starting gate body", async () => {
    let polls = 0;
    const url = serveReadyz(() => {
      polls++;
      return polls < 2
        ? Response.json({ status: "starting", ready: false })
        : Response.json({ status: "ok", ready: true });
    });

    expect(await waitForReady(url)).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  test("fails fast on terminally failed migrations so rollback can run", async () => {
    const url = serveReadyz(() =>
      Response.json(
        {
          status: "upstream_unhealthy",
          upstream: 503,
          ready: false,
          dbMigrations: { ready: false, state: "failed" },
        },
        { status: 503 },
      ),
    );

    const started = Date.now();
    expect(await waitForReady(url)).toBe(false);
    // Terminal state short-circuits — nowhere near the 5-minute timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("treats a legacy 200 body without a ready field as ready", async () => {
    // Pre-migration-body gateways returned a fixed { status: "ok" }.
    const url = serveReadyz(() => Response.json({ status: "ok" }));
    expect(await waitForReady(url)).toBe(true);
  });
});
