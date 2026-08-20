import { afterEach, describe, expect, test } from "bun:test";

import { emitDaemonError } from "../../daemon/startup-error.js";
import {
  startRuntimeHttpServer,
  stopRuntimeHttpServer,
} from "../http-server.js";

/**
 * The daemon binds two client-facing transports. An occupied runtime HTTP port
 * must abort startup the same way an occupied IPC socket does, so the daemon
 * can never answer IPC (reading healthy to `vellum ps` and platform status)
 * while the gateway proxies /v1/* to a foreign listener.
 */
describe("runtime HTTP port collision", () => {
  const originalPort = process.env.RUNTIME_HTTP_PORT;

  afterEach(async () => {
    await stopRuntimeHttpServer();
    if (originalPort === undefined) {
      delete process.env.RUNTIME_HTTP_PORT;
    } else {
      process.env.RUNTIME_HTTP_PORT = originalPort;
    }
  });

  test("aborts startup when a foreign process holds the runtime HTTP port", async () => {
    /**
     * Tests that a runtime HTTP bind collision fails daemon startup instead of
     * silently degrading to IPC-only operation.
     */

    // GIVEN a foreign process holding a port
    const foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("foreign"),
    });

    // AND the daemon configured to serve HTTP on that same port
    process.env.RUNTIME_HTTP_PORT = String(foreign.port);

    try {
      // WHEN the daemon starts its runtime HTTP server
      const err = await startRuntimeHttpServer().then(
        () => null,
        (e: unknown) => e,
      );

      // THEN startup fails rather than continuing without HTTP
      expect(err).toBeInstanceOf(Error);

      // AND the failure carries the address-collision code the daemon's
      // startup-error categorization branches on
      expect((err as NodeJS.ErrnoException).code).toBe("EADDRINUSE");

      // AND the message names the occupied port and the env var that moves it
      expect((err as Error).message).toContain(String(foreign.port));
      expect((err as Error).message).toContain("RUNTIME_HTTP_PORT");
    } finally {
      foreign.stop(true);
    }
  });

  test("reports a runtime HTTP port collision as PORT_IN_USE on stderr", async () => {
    /**
     * Tests that the bind failure reaches consumers that parse the daemon's
     * structured startup-error line (e.g. the macOS app) as PORT_IN_USE.
     */

    // GIVEN a foreign process holding the daemon's runtime HTTP port
    const foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("foreign"),
    });
    process.env.RUNTIME_HTTP_PORT = String(foreign.port);

    // AND stderr captured so the structured startup-error line is observable
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      // WHEN the daemon's startup error handler reports the bind failure
      const err = await startRuntimeHttpServer().then(
        () => null,
        (e: unknown) => e,
      );
      emitDaemonError(err);

      // THEN the structured line categorizes the failure as PORT_IN_USE
      const line = written.find((entry) => entry.includes("DAEMON_ERROR:"));
      expect(line).toBeDefined();
      const structured = JSON.parse(
        (line as string).replace("DAEMON_ERROR:", "").trim(),
      ) as Record<string, unknown>;
      expect(structured.error).toBe("PORT_IN_USE");
    } finally {
      process.stderr.write = originalWrite;
      foreign.stop(true);
    }
  });

  test("binds and leaves the singleton serving when the port is free", async () => {
    /**
     * Tests that the collision guard does not turn ordinary startup into a
     * failure: a free port still yields a listening HTTP server.
     */

    // GIVEN a free port for the runtime HTTP server
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("probe"),
    });
    const freePort = probe.port;
    probe.stop(true);
    process.env.RUNTIME_HTTP_PORT = String(freePort);

    // WHEN the daemon starts its runtime HTTP server
    await startRuntimeHttpServer();

    // THEN the server answers its liveness probe
    const response = await fetch(`http://127.0.0.1:${freePort}/healthz`);
    expect(response.status).toBe(200);
  });
});
