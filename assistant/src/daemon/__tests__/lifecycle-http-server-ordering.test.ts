import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Structural guard for `runDaemon` startup ordering in
 * `assistant/src/daemon/lifecycle.ts`.
 *
 * The runtime HTTP server must come up as early as possible so the
 * `/healthz` and `/readyz` probes return 200 OK while the rest of
 * startup (DB init, workspace migrations, CES handshake, plugin
 * bootstrap, DaemonServer.start, ...) is still running. The probe
 * handlers themselves don't touch the DB or any other subsystem, so
 * binding the socket is the only prerequisite for "healthy".
 *
 * This test pins those invariants via positional string matches in the
 * source file. They're brittle on purpose — they catch the regression
 * where `runtimeHttp.start()` quietly slides back behind DB init or
 * CES handshake during a refactor.
 *
 * Invariants:
 *   1. `runtimeHttp.start()` is awaited.
 *   2. It happens BEFORE `initializeDb()` is called.
 *   3. It happens BEFORE `startCesProcess(config)` is called.
 *   4. It happens BEFORE `new DaemonServer()` is constructed.
 *   5. Its `start()` call is wrapped in its OWN `try { ... } catch`,
 *      i.e. not sharing a try block with later side effects like
 *      `server.broadcastStatus()` (where a server-only error would
 *      silently null out `runtimeHttp`).
 */

const LIFECYCLE_PATH = join(
  import.meta.dir,
  "..",
  "lifecycle.ts",
);

function indexOfOrThrow(source: string, needle: string): number {
  const idx = source.indexOf(needle);
  if (idx === -1) {
    throw new Error(
      `Expected to find "${needle}" in lifecycle.ts but it was absent.`,
    );
  }
  return idx;
}

describe("runDaemon HTTP server ordering", () => {
  const source = readFileSync(LIFECYCLE_PATH, "utf-8");

  it("awaits runtimeHttp.start() before initializeDb()", () => {
    // Match the actual call statement (`initializeDb();`), not the
    // import line or the comment a few hundred lines up that mentions
    // it by name.
    const startIdx = indexOfOrThrow(source, "await runtimeHttp.start()");
    const dbInitIdx = indexOfOrThrow(source, "initializeDb();");
    expect(startIdx).toBeLessThan(dbInitIdx);
  });

  it("awaits runtimeHttp.start() before startCesProcess(config)", () => {
    const startIdx = indexOfOrThrow(source, "await runtimeHttp.start()");
    const cesIdx = indexOfOrThrow(source, "startCesProcess(config);");
    expect(startIdx).toBeLessThan(cesIdx);
  });

  it("awaits runtimeHttp.start() before constructing DaemonServer", () => {
    const startIdx = indexOfOrThrow(source, "await runtimeHttp.start()");
    const daemonServerIdx = indexOfOrThrow(source, "new DaemonServer();");
    expect(startIdx).toBeLessThan(daemonServerIdx);
  });

  it("wraps runtimeHttp.start() in its own try/catch", () => {
    // Find the line containing `await runtimeHttp.start()` and scan
    // backwards for the nearest `try {`. The block this `try` opens
    // must close before any unrelated side effects sneak in — concretely
    // we require its `} catch` to appear before `server.broadcastStatus`.
    const startIdx = indexOfOrThrow(source, "await runtimeHttp.start()");

    const before = source.slice(0, startIdx);
    const tryIdx = before.lastIndexOf("try {");
    expect(tryIdx).toBeGreaterThan(-1);

    const tail = source.slice(tryIdx);
    const catchIdx = tail.indexOf("} catch");
    expect(catchIdx).toBeGreaterThan(-1);

    // The matching catch block must close before `server.broadcastStatus(`
    // is invoked. If they share a try, a refactor that throws on
    // broadcastStatus would silently null out runtimeHttp.
    const absoluteCatchIdx = tryIdx + catchIdx;
    const broadcastStatusIdx = source.indexOf("server.broadcastStatus(");
    if (broadcastStatusIdx !== -1) {
      expect(absoluteCatchIdx).toBeLessThan(broadcastStatusIdx);
    }
  });
});
