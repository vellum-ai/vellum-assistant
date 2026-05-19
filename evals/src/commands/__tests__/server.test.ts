import { describe, expect, test } from "bun:test";

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
} from "../../lib/metrics";

async function seedRun(input: {
  sessionId: string;
  profileId: string;
  testId: string;
  sessionLabel?: string;
}): Promise<string> {
  const runId = `test-server-${input.sessionId}-${input.profileId}-${input.testId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    expect(html).toContain("Metric breakdown");
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
