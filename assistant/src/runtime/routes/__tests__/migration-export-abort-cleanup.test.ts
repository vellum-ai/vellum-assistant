/**
 * Regression tests for temp-file cleanup on the direct-download export route.
 *
 * `handleMigrationExport` took its `RouteHandlerArgs` as `_args` and dropped
 * them, so `req.signal` — which both adapters already pass — was available and
 * unused. Cleanup hung off a single trigger, the read stream's `close` event,
 * which fires on a completed transfer but not on a client abort or connection
 * drop. Every disconnect stranded a workspace-sized archive in `$TMPDIR`.
 *
 * These drive the real handler against a real workspace so the assertions are
 * about files on disk, not about a mocked call being made.
 *
 * **What is not covered, and why.** The disconnect itself is not reproducible
 * in-process. Calling the handler directly leaves no socket to die, and the
 * runtime drains the response stream to EOF whether or not anything is reading
 * it — so `close` fires and the pre-existing cleanup runs regardless. The abort
 * binding exists for the case a unit test cannot create: a real connection that
 * goes away, leaving the body unread and the stream open. A test asserting it
 * here would pass against the unfixed code and prove nothing.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assertNotLiveDb } from "../../../__tests__/assert-not-live-db.js";
import { waitFor } from "../../../__tests__/helpers/wait-for.js";
import { handleMigrationExport } from "../migration-routes.js";

let workspaceDir: string;
let previousWorkspaceDir: string | undefined;

/** Export archives staged in the temp directory right now. */
function stagedExports(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith("vbundle-export-") && name.endsWith(".tmp"),
  );
}

beforeEach(() => {
  workspaceDir = join(tmpdir(), `export-abort-ws-${crypto.randomUUID()}`);
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  writeFileSync(join(workspaceDir, "config.json"), JSON.stringify({}));
  writeFileSync(join(workspaceDir, "data", "db", "assistant.db"), "db-bytes");

  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(async () => {
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
  assertNotLiveDb(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("handleMigrationExport — abort cleanup", () => {
  test("a client already gone is not built for at all", async () => {
    const before = new Set(stagedExports());

    const controller = new AbortController();
    controller.abort();

    const result = await handleMigrationExport({
      abortSignal: controller.signal,
    });

    // Reported as a disconnect rather than handed a body nobody is reading.
    expect(result.status).toBe(499);
    expect(result.body).toBeNull();

    // And nothing was staged: the build is skipped outright, which on a large
    // workspace is an hour of CPU and tens of gigabytes not spent.
    expect(stagedExports().filter((n) => !before.has(n))).toEqual([]);
  }, 60_000);

  test("a completed transfer still evicts via the stream's own close", async () => {
    const before = new Set(stagedExports());

    const result = await handleMigrationExport({});

    expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    expect(Number(result.headers["Content-Length"])).toBeGreaterThan(0);

    // Draining the body to completion closes the read stream, which is the
    // trigger that already worked and must keep working.
    await new Response(result.body).arrayBuffer();

    await waitFor(() => stagedExports().every((name) => before.has(name)), {
      timeoutMs: 5_000,
      message: "staged archive was never evicted after a completed transfer",
    });
  }, 60_000);
});
