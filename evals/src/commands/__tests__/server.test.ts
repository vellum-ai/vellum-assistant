import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  handleRequest,
  openInBrowser,
  resolveBrowserCommand,
  startReportServer,
} from "../server";
import {
  ensureRunArtifacts,
  writeMetricResults,
  writeRunMetadata,
  RUNS_DIR,
} from "../../lib/metrics";

// Counter ensures uniqueness even when two seedRuns land inside the
// same millisecond — mirrors the random-hex suffix
// `commands/run.ts#timestampSuffix` appends in production.
let seedCounter = 0;

async function seedRun(input: {
  sessionId: string;
  profileId: string;
  testId: string;
  sessionLabel?: string;
}): Promise<string> {
  const slug = `${input.profileId}-${input.testId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Match the production shape exactly: 17-digit ms timestamp + 4 hex.
  // Date.now() (13 digits) → pad to 17 with a counter-derived suffix.
  const timestamp = `${Date.now()}${seedCounter++}000`.slice(-17);
  const rand = `${seedCounter.toString(16).padStart(4, "0")}`.slice(-4);
  const runId = `eval-${slug}-${timestamp}-${rand}`;
  const artifacts = await ensureRunArtifacts(runId);
  await writeRunMetadata(runId, {
    runId,
    sessionId: input.sessionId,
    sessionLabel: input.sessionLabel,
    profileId: input.profileId,
    testId: input.testId,
    status: "completed",
    startedAt: "2026-05-18T18:00:00.000Z",
    completedAt: "2026-05-18T18:00:02.000Z",
    artifactDir: artifacts.runDir,
  });
  await writeMetricResults(runId, [{ name: "acc", score: 0.5 }]);
  return runId;
}

function req(path: string): Request {
  return new Request(`http://localhost:3005${path}`);
}

describe("evals server routing", () => {
  test("/ renders the index with a session entry for each seeded session", async () => {
    const sessionId = `session-route-index-${Date.now()}`;
    await seedRun({
      sessionId,
      profileId: "p1",
      testId: "t1",
      sessionLabel: "routing-smoke",
    });

    const res = await handleRequest(req("/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("routing-smoke");
    expect(html).toContain(sessionId);
    expect(html).toContain(`href="/sessions/${sessionId}"`);
  });

  test("/sessions/<id> renders the session detail page", async () => {
    const sessionId = `session-route-detail-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });
    await seedRun({ sessionId, profileId: "p2", testId: "t1" });

    const res = await handleRequest(req(`/sessions/${sessionId}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile scores");
    expect(html).toContain("p1");
    expect(html).toContain("p2");
    expect(html).toContain(`href="/sessions/${sessionId}/tests/t1"`);
  });

  test("/sessions/<id>/tests/<testId> renders the test-in-session page", async () => {
    const sessionId = `session-route-test-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });
    await seedRun({ sessionId, profileId: "p2", testId: "t1" });

    const res = await handleRequest(req(`/sessions/${sessionId}/tests/t1`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profiles");
    expect(html).toContain("Responses");
    expect(html).toContain("Runtime");
    expect(html).not.toContain("Metric breakdown");
    expect(html).toContain(
      `href="/sessions/${sessionId}/tests/t1/profiles/p1"`,
    );
  });

  test("/sessions/<id>/tests/<testId>/profiles/<profileId> renders the execution detail page with logs and no raw JSON", async () => {
    const sessionId = `session-route-exec-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    const res = await handleRequest(
      req(`/sessions/${sessionId}/tests/t1/profiles/p1`),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Container logs");
    expect(html).toContain("Test runner logs");
    expect(html).not.toContain("Raw data");
    expect(html).not.toContain("Open JSON payload");
  });

  test("missing session returns a 404 page", async () => {
    const res = await handleRequest(req("/sessions/does-not-exist"));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Not found");
  });

  test("missing execution returns a 404 page", async () => {
    const sessionId = `session-route-404-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });
    const res = await handleRequest(
      req(`/sessions/${sessionId}/tests/t1/profiles/missing`),
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("No execution found");
  });

  test("API endpoint /api/sessions returns the same data as the page", async () => {
    const sessionId = `session-route-api-${Date.now()}`;
    await seedRun({
      sessionId,
      profileId: "p1",
      testId: "t1",
      sessionLabel: "json-smoke",
    });

    const res = await handleRequest(req("/api/sessions"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const sessions = (await res.json()) as Array<{
      sessionId: string;
      sessionLabel?: string;
    }>;
    const match = sessions.find((session) => session.sessionId === sessionId);
    expect(match?.sessionLabel).toBe("json-smoke");
  });

  test("unknown path returns 404 page", async () => {
    const res = await handleRequest(req("/garbage"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Not found");
  });

  test("trailing slashes don't cause routing misses", async () => {
    const sessionId = `session-route-slash-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });
    const res = await handleRequest(req(`/sessions/${sessionId}/`));
    expect(res.status).toBe(200);
  });

  test("GET /api/runs/:runId/files/:name serves subprocess log files", async () => {
    const sessionId = `session-route-file-${Date.now()}`;
    const runId = await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    // Write a subprocess log file
    const logContent = "Subprocess hatch started at 2026-05-22T13:00:00Z";
    await writeFile(join(RUNS_DIR, runId, "subprocess-hatch.log"), logContent);

    // Request the file
    const res = await handleRequest(
      req(`/api/runs/${encodeURIComponent(runId)}/files/subprocess-hatch.log`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toBe(logContent);
  });

  test("GET /api/runs/:runId/files/:name rejects invalid filenames", async () => {
    const sessionId = `session-route-file-invalid-${Date.now()}`;
    const runId = await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    // Use percent-encoded dots so `new URL()` doesn't collapse the
    // segments before our handler sees them. After `decodeURIComponent`
    // the file name becomes `../../../../etc/passwd`, which the
    // allowlist regex (subprocess-*.log + docker-*) must reject. The
    // raw-dots form would normalize to `/etc/passwd` and never reach
    // the endpoint — so it wouldn't exercise the security check.
    const evilName = "%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd";
    const res = await handleRequest(
      req(`/api/runs/${encodeURIComponent(runId)}/files/${evilName}`),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid file name");
  });

  test("GET /api/runs/:runId/files/:name serves per-sibling docker artifacts", async () => {
    // The vellum adapter writes one `docker-inspect-<service>.json` +
    // `docker-logs-<service>.txt` pair per sibling container
    // (assistant / gateway / credential-executor) so the operator can
    // see WHICH sibling crashed, not just "something in the hatch
    // chain died". The allowlist must accept these filenames or the
    // raw-download links the report UI now exposes 404 in the browser.
    const sessionId = `session-route-file-sibling-${Date.now()}`;
    const runId = await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    const gatewayInspect =
      '{"State":{"Status":"created","ExitCode":0,"Error":"bind for 0.0.0.0:20100 failed"}}';
    const gatewayLogs = "panic: address already in use\n";
    await writeFile(
      join(RUNS_DIR, runId, "docker-inspect-gateway.json"),
      gatewayInspect,
    );
    await writeFile(
      join(RUNS_DIR, runId, "docker-logs-gateway.txt"),
      gatewayLogs,
    );

    const inspectRes = await handleRequest(
      req(
        `/api/runs/${encodeURIComponent(runId)}/files/docker-inspect-gateway.json`,
      ),
    );
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(await inspectRes.text()).toBe(gatewayInspect);

    const logsRes = await handleRequest(
      req(
        `/api/runs/${encodeURIComponent(runId)}/files/docker-logs-gateway.txt`,
      ),
    );
    expect(logsRes.status).toBe(200);
    expect(logsRes.headers.get("content-type")).toContain("text/plain");
    expect(await logsRes.text()).toBe(gatewayLogs);
  });

  test("GET /api/runs/:runId/files/:name returns 404 for missing files", async () => {
    const sessionId = `session-route-file-404-${Date.now()}`;
    const runId = await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    const res = await handleRequest(
      req(
        `/api/runs/${encodeURIComponent(runId)}/files/subprocess-nonexistent.log`,
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("File not found");
  });

  test("DELETE /api/runs/:runId removes the run directory", async () => {
    const sessionId = `session-del-one-${Date.now()}`;
    const runId = await seedRun({ sessionId, profileId: "p1", testId: "t1" });

    const res = await handleRequest(
      new Request(
        `http://localhost:3005/api/runs/${encodeURIComponent(runId)}`,
        { method: "DELETE" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted?: string };
    expect(body.deleted).toBe(runId);

    // Re-fetching the file endpoint after delete returns 404 — proving
    // the directory really is gone.
    const after = await handleRequest(
      req(`/api/runs/${encodeURIComponent(runId)}/files/subprocess-x.log`),
    );
    expect(after.status).toBe(404);
  });

  test("DELETE /api/runs/:runId rejects malformed runIds with 400", async () => {
    const res = await handleRequest(
      new Request("http://localhost:3005/api/runs/not-an-eval-runid", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/runs bulk-deletes non-running runs and skips running ones", async () => {
    const sessionId = `session-del-bulk-${Date.now()}`;
    const completed = await seedRun({
      sessionId,
      profileId: "p1",
      testId: "t1",
    });
    const failed = await seedRun({
      sessionId,
      profileId: "p2",
      testId: "t1",
    });
    // Flip one to status: "running" with a fresh heartbeat so the
    // scavenger won't reap it before the delete endpoint sees it.
    const stillRunning = await seedRun({
      sessionId,
      profileId: "p3",
      testId: "t1",
    });
    const { writeRunMetadata, readRunMetadata } =
      await import("../../lib/metrics");
    const meta = await readRunMetadata(stillRunning);
    await writeRunMetadata(stillRunning, {
      ...meta!,
      status: "running",
      lastHeartbeatAt: new Date().toISOString(),
    });

    const res = await handleRequest(
      new Request("http://localhost:3005/api/runs", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; skipped: number };
    expect(body.deleted).toBeGreaterThanOrEqual(2);
    expect(body.skipped).toBeGreaterThanOrEqual(1);

    // Sanity: the still-running run is still on disk.
    const survivor = await readRunMetadata(stillRunning);
    expect(survivor?.status).toBe("running");
    // And the completed + failed ones are gone (404 on file endpoint).
    const gone = await handleRequest(
      req(`/api/runs/${encodeURIComponent(completed)}/files/subprocess-x.log`),
    );
    expect(gone.status).toBe(404);
    expect(failed).toBeTruthy(); // (failed too — same path)
  });

  // -- form-driven delete endpoints (no client JS) --------------------------

  test("POST /api/runs/:runId/delete removes the run and 303-redirects to the session", async () => {
    const sessionId = `session-form-del-${Date.now()}`;
    const runId = await seedRun({
      sessionId,
      profileId: "p1",
      testId: "t1",
    });
    const body = new URLSearchParams({ backToSession: sessionId });
    const res = await handleRequest(
      new Request(
        `http://localhost:3005/api/runs/${encodeURIComponent(runId)}/delete`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    // Verify the run directory is gone.
    const gone = await handleRequest(
      req(`/api/runs/${encodeURIComponent(runId)}/files/subprocess-x.log`),
    );
    expect(gone.status).toBe(404);
  });

  test("POST /api/runs/:runId/delete falls back to `/` when no backToSession is supplied", async () => {
    const runId = await seedRun({
      sessionId: `session-form-del-noback-${Date.now()}`,
      profileId: "p1",
      testId: "t1",
    });
    const res = await handleRequest(
      new Request(
        `http://localhost:3005/api/runs/${encodeURIComponent(runId)}/delete`,
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  test("POST /api/runs/:runId/delete renders an HTML error page (not JSON) for malformed runIds", async () => {
    const res = await handleRequest(
      new Request("http://localhost:3005/api/runs/not-an-eval-runid/delete", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    // Browsers post the form — they expect HTML back, not JSON. Confirm
    // the content-type and that we link the user back somewhere useful.
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Invalid runId format");
    expect(body).toContain('href="/"');
  });

  test("POST /api/runs/delete-all bulk-deletes and 303-redirects to `/`", async () => {
    const sessionId = `session-form-del-all-${Date.now()}`;
    await seedRun({ sessionId, profileId: "p1", testId: "t1" });
    await seedRun({ sessionId, profileId: "p2", testId: "t1" });

    const res = await handleRequest(
      new Request("http://localhost:3005/api/runs/delete-all", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("resolveBrowserCommand", () => {
  test("darwin uses `open`", () => {
    const { command, args } = resolveBrowserCommand(
      "darwin",
      "http://127.0.0.1:3005/sessions/x",
    );
    expect(command).toBe("open");
    expect(args).toEqual(["http://127.0.0.1:3005/sessions/x"]);
  });

  test("win32 uses `cmd /c start` with an empty title arg", () => {
    const { command, args } = resolveBrowserCommand(
      "win32",
      "http://127.0.0.1:3005/sessions/x",
    );
    expect(command).toBe("cmd");
    // The empty `""` title arg prevents URLs with `&` from being
    // misparsed as window titles by `start`. Keep it second.
    expect(args).toEqual([
      "/c",
      "start",
      '""',
      "http://127.0.0.1:3005/sessions/x",
    ]);
  });

  test("linux uses `xdg-open`", () => {
    const { command, args } = resolveBrowserCommand(
      "linux",
      "http://127.0.0.1:3005/sessions/x",
    );
    expect(command).toBe("xdg-open");
    expect(args).toEqual(["http://127.0.0.1:3005/sessions/x"]);
  });

  test("unknown platforms fall back to xdg-open rather than throwing", () => {
    // freebsd is a real NodeJS.Platform value but we don't special-case
    // it; verify the fallback branch returns something usable.
    const { command, args } = resolveBrowserCommand(
      "freebsd",
      "http://127.0.0.1:3005/sessions/x",
    );
    expect(command).toBe("xdg-open");
    expect(args).toEqual(["http://127.0.0.1:3005/sessions/x"]);
  });
});

describe("openInBrowser", () => {
  test("does not throw when the helper binary is missing", () => {
    // Even in environments without xdg-open / open / cmd, the helper
    // must silently swallow the failure — the URL has already been
    // printed to stdout for the user to click.
    expect(() => {
      openInBrowser("http://127.0.0.1:3005/sessions/nope");
    }).not.toThrow();
  });
});

describe("startReportServer", () => {
  test("returns a bound URL and serves /api/sessions", async () => {
    // Bind to an OS-chosen ephemeral port to avoid collisions with
    // other test runs on the same box. Bun.serve accepts port 0 for
    // this.
    const handle = startReportServer({ host: "127.0.0.1", port: 0 });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await fetch(`${handle.url}/api/sessions`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      // We don't seed here — just confirm the route plumbing is live.
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
