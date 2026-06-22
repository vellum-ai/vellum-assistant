/** `evals server` — local HTML report browser for .runs artifacts. */
import { readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "commander";

import { renderReportPage, type ReportPageInput } from "../lib/report-html";
import {
  readRunMetadata,
  RUNS_DIR,
  scavengeAbandonedRuns,
} from "../lib/metrics";
import { startNgrokTunnel, type NgrokTunnel } from "../lib/ngrok";
import {
  findExecutionRunId,
  listReportSessions,
  readProfileInSession,
  readReportRun,
  readReportSession,
  readTestInSession,
} from "../lib/report-data";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3005;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Issues a 303 See Other to `location`. Used by the form-driven delete
 * endpoints so a successful POST navigates the browser to the next page
 * (session detail, or `/`) — no JS, no fetch, no hand-rolled IIFE.
 */
function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/**
 * Renders a minimal HTML error page for the form-driven delete endpoints.
 * We can't use `notFoundPage` here because that machinery is shaped around
 * the report schema; this is a flat, no-frills page with a link back so
 * the user is never stranded if a POST fails server-side.
 */
function errorPage(message: string, backHref: string, status = 500): Response {
  const safe = message.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Error</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5"><h1>Something went wrong</h1><p>${safe}</p><p><a href="${backHref}">Back</a></p></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function htmlResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function pageResponse(input: ReportPageInput, status = 200): Response {
  return htmlResponse(renderReportPage(input), status);
}

function notFoundPage(message: string): Response {
  return pageResponse({ kind: "not-found", message }, 404);
}

function notFoundJson(message: string): Response {
  return jsonResponse({ error: message }, 404);
}

/**
 * Validates that a runId is safe to use in file system operations.
 * Returns true if it matches `eval-<slug>-<17-digit
 * YYYYMMDDhhmmssSSS>-<4 hex chars>` (produced by
 * `commands/run.ts#timestampSuffix`). Prevents path traversal attacks
 * via the runId path segment.
 */
function isValidRunId(runId: string): boolean {
  return /^eval-[a-z0-9\-]+-\d{17}-[a-f0-9]{4}$/.test(runId);
}

/**
 * Allowlist of bare filenames the GET file endpoint will serve from a
 * run directory. The list is closed (no path-segment characters allowed
 * in the name) so a malicious URL like `..%2Fetc%2Fpasswd` can never
 * match — `isValidRunId` is the first defense, this is the second.
 *
 * Allowed:
 *   - `subprocess-<step>.log` — adapter subprocess tee output
 *   - `docker-inspect-<service>.json` / `docker-logs-<service>.txt` —
 *     per-sibling-container forensics written by the vellum adapter's
 *     catch path (one pair per `vellumDockerSiblingContainers` entry:
 *     assistant, gateway, credential-executor)
 */
function isAllowedRunArtifactName(name: string): boolean {
  if (/^docker-inspect-[a-z0-9\-]+\.json$/.test(name)) return true;
  if (/^docker-logs-[a-z0-9\-]+\.txt$/.test(name)) return true;
  return /^subprocess-[a-z0-9\-]+\.log$/.test(name);
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/") {
    // Run scavenger on each index page load to catch stale runs.
    await scavengeAbandonedRuns();
    const sessions = await listReportSessions();
    return pageResponse({ kind: "index", sessions });
  }

  if (path === "/api/sessions") {
    return jsonResponse(await listReportSessions());
  }

  const apiExecution = path.match(
    /^\/api\/sessions\/([^/]+)\/tests\/([^/]+)\/profiles\/([^/]+)$/,
  );
  if (apiExecution) {
    const [, sessionEnc, testEnc, profileEnc] = apiExecution;
    const sessionId = decodeURIComponent(sessionEnc);
    const testId = decodeURIComponent(testEnc);
    const profileId = decodeURIComponent(profileEnc);
    const runId = await findExecutionRunId(sessionId, testId, profileId);
    if (!runId) {
      return notFoundJson(
        `No execution found for session ${sessionId}, test ${testId}, profile ${profileId}`,
      );
    }
    return jsonResponse(await readReportRun(runId));
  }

  const apiTest = path.match(/^\/api\/sessions\/([^/]+)\/tests\/([^/]+)$/);
  if (apiTest) {
    const [, sessionEnc, testEnc] = apiTest;
    const sessionId = decodeURIComponent(sessionEnc);
    const testId = decodeURIComponent(testEnc);
    const test = await readTestInSession(sessionId, testId);
    if (!test) {
      return notFoundJson(`No test ${testId} found in session ${sessionId}`);
    }
    return jsonResponse(test);
  }

  const apiProfile = path.match(
    /^\/api\/sessions\/([^/]+)\/profiles\/([^/]+)$/,
  );
  if (apiProfile) {
    const [, sessionEnc, profileEnc] = apiProfile;
    const sessionId = decodeURIComponent(sessionEnc);
    const profileId = decodeURIComponent(profileEnc);
    const profile = await readProfileInSession(sessionId, profileId);
    if (!profile) {
      return notFoundJson(
        `No profile ${profileId} found in session ${sessionId}`,
      );
    }
    return jsonResponse(profile);
  }

  const apiSession = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (apiSession) {
    const sessionId = decodeURIComponent(apiSession[1]);
    const session = await readReportSession(sessionId);
    if (!session) return notFoundJson(`No session ${sessionId}`);
    return jsonResponse(session);
  }

  const pageExecution = path.match(
    /^\/sessions\/([^/]+)\/tests\/([^/]+)\/profiles\/([^/]+)$/,
  );
  if (pageExecution) {
    const [, sessionEnc, testEnc, profileEnc] = pageExecution;
    const sessionId = decodeURIComponent(sessionEnc);
    const testId = decodeURIComponent(testEnc);
    const profileId = decodeURIComponent(profileEnc);
    const runId = await findExecutionRunId(sessionId, testId, profileId);
    if (!runId) {
      return notFoundPage(
        `No execution found for session ${sessionId}, test ${testId}, profile ${profileId}.`,
      );
    }
    return pageResponse({ kind: "execution", run: await readReportRun(runId) });
  }

  const pageTest = path.match(/^\/sessions\/([^/]+)\/tests\/([^/]+)$/);
  if (pageTest) {
    const [, sessionEnc, testEnc] = pageTest;
    const sessionId = decodeURIComponent(sessionEnc);
    const testId = decodeURIComponent(testEnc);
    const test = await readTestInSession(sessionId, testId);
    if (!test) {
      return notFoundPage(`No test ${testId} found in session ${sessionId}.`);
    }
    return pageResponse({ kind: "test", test });
  }

  const pageProfile = path.match(/^\/sessions\/([^/]+)\/profiles\/([^/]+)$/);
  if (pageProfile) {
    const [, sessionEnc, profileEnc] = pageProfile;
    const sessionId = decodeURIComponent(sessionEnc);
    const profileId = decodeURIComponent(profileEnc);
    const profile = await readProfileInSession(sessionId, profileId);
    if (!profile) {
      return notFoundPage(
        `No profile ${profileId} found in session ${sessionId}.`,
      );
    }
    return pageResponse({ kind: "profile", profile });
  }

  const pageSession = path.match(/^\/sessions\/([^/]+)$/);
  if (pageSession) {
    const sessionId = decodeURIComponent(pageSession[1]);
    const session = await readReportSession(sessionId);
    if (!session) return notFoundPage(`No session ${sessionId}.`);
    return pageResponse({ kind: "session", session });
  }

  // GET /api/runs/:runId/files/:name — serve a per-run diagnostic artifact
  // as plain text. Allowed names are the subprocess log tee outputs plus the
  // docker forensics dump emitted by the vellum adapter on hatch failure.
  const apiRunFile = path.match(/^\/api\/runs\/([^/]+)\/files\/(.+)$/);
  if (apiRunFile && method === "GET") {
    const [, runIdEnc, fileNameEnc] = apiRunFile;
    const runId = decodeURIComponent(runIdEnc);
    const fileName = decodeURIComponent(fileNameEnc);

    if (!isValidRunId(runId)) {
      return jsonResponse({ error: `Invalid runId format: ${runId}` }, 400);
    }
    if (!isAllowedRunArtifactName(fileName)) {
      return jsonResponse({ error: `Invalid file name: ${fileName}` }, 400);
    }

    try {
      const filePath = join(RUNS_DIR, runId, fileName);
      const content = await readFile(filePath, "utf-8");
      const contentType = fileName.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8";
      return new Response(content, {
        status: 200,
        headers: { "content-type": contentType },
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("ENOENT")) {
        return notFoundJson(`File not found: ${runId}/${fileName}`);
      }
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to read file" },
        500,
      );
    }
  }

  // DELETE /api/runs/:runId — JSON API: remove a specific run directory.
  // POST   /api/runs/:runId/delete — form endpoint: same effect, 303-redirects
  //                                  to the referenced session (or `/`).
  // Both routes funnel through `deleteRunOnDisk` so behaviour stays in lockstep.
  const apiDeleteRun = path.match(/^\/api\/runs\/([^/]+)$/);
  if (apiDeleteRun && method === "DELETE") {
    const runId = decodeURIComponent(apiDeleteRun[1]);
    if (!isValidRunId(runId)) {
      return jsonResponse({ error: `Invalid runId format: ${runId}` }, 400);
    }
    const result = await deleteRunOnDisk(runId);
    if (!result.ok) return jsonResponse({ error: result.error }, 500);
    return jsonResponse({ deleted: runId });
  }

  const apiDeleteRunForm = path.match(/^\/api\/runs\/([^/]+)\/delete$/);
  if (apiDeleteRunForm && method === "POST") {
    const runId = decodeURIComponent(apiDeleteRunForm[1]);
    if (!isValidRunId(runId)) {
      return errorPage(`Invalid runId format: ${runId}`, "/", 400);
    }
    let backToSession: string | undefined;
    try {
      const form = await request.formData();
      const raw = form.get("backToSession");
      if (typeof raw === "string" && raw.length > 0) backToSession = raw;
    } catch {
      // No body / not form-encoded — fall through with no session hint.
    }
    const result = await deleteRunOnDisk(runId);
    if (!result.ok) {
      const back = backToSession
        ? `/sessions/${encodeURIComponent(backToSession)}`
        : "/";
      return errorPage(`Failed to delete run: ${result.error}`, back, 500);
    }
    return redirectResponse(
      backToSession ? `/sessions/${encodeURIComponent(backToSession)}` : "/",
    );
  }

  // DELETE /api/runs        — JSON API: bulk-delete every non-running run.
  // POST   /api/runs/delete-all — form endpoint: same effect, 303 to `/`.
  // We scavenge stale heartbeats first so a 60s-dead run still gets cleaned up
  // even though it hasn't been flipped to `abandoned` yet by the index page.
  if (path === "/api/runs" && method === "DELETE") {
    const result = await deleteAllNonRunningOnDisk();
    if (!result.ok) return jsonResponse({ error: result.error }, 500);
    return jsonResponse({ deleted: result.deleted, skipped: result.skipped });
  }

  if (path === "/api/runs/delete-all" && method === "POST") {
    const result = await deleteAllNonRunningOnDisk();
    if (!result.ok) {
      return errorPage(`Failed to delete runs: ${result.error}`, "/", 500);
    }
    return redirectResponse("/");
  }

  return notFoundPage(`No route matches ${url.pathname}.`);
}

/**
 * Shared implementation for the JSON-DELETE and form-POST delete endpoints.
 * Returns a tagged result so each entry point can shape its own response —
 * JSON for scripts, 303-redirect for the browser-driven form.
 */
async function deleteRunOnDisk(
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const runPath = join(RUNS_DIR, runId);
    await rm(runPath, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete run",
    };
  }
}

/**
 * Shared implementation for the JSON-DELETE and form-POST bulk-delete
 * endpoints. Scavenges stale heartbeats first, then walks every run dir
 * that matches the runId shape and removes any whose status is not
 * currently `running`.
 */
async function deleteAllNonRunningOnDisk(): Promise<
  { ok: true; deleted: number; skipped: number } | { ok: false; error: string }
> {
  try {
    await scavengeAbandonedRuns();
    const runDirs = await readdir(RUNS_DIR).catch(() => [] as string[]);
    let deleted = 0;
    let skipped = 0;
    for (const runDir of runDirs) {
      if (!isValidRunId(runDir)) continue;
      const metadata = await readRunMetadata(runDir).catch(() => undefined);
      if (metadata && metadata.status === "running") {
        skipped += 1;
        continue;
      }
      try {
        await rm(join(RUNS_DIR, runDir), { recursive: true, force: true });
        deleted += 1;
      } catch {
        // Silently skip on error — next bulk-delete will pick it up.
      }
    }
    return { ok: true, deleted, skipped };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete runs",
    };
  }
}

/** Subset of the Bun.serve handle that callers need. */
export interface ReportServerHandle {
  url: string;
  stop(): Promise<void>;
}

/**
 * Boot the local report server on the given host/port and return its bound
 * URL plus a stop handle. Used by both `evals server` (foreground) and
 * `evals run --serve` (post-run auto-launch). Returns the actual bound
 * URL so callers can print a click-target and so the `--serve` path
 * can hand the URL to the OS "open" shell helper. The stop handle lets
 * tests clean up without leaking the event loop.
 *
 * Bun.serve binds synchronously and runs the loop until the process
 * exits, so callers retain control immediately and the server stays up
 * until ctrl-C (or `.stop()`).
 *
 * Port `0` asks the OS for an ephemeral port — useful in tests to
 * avoid collisions with other suites on the same box.
 */
export function startReportServer(opts?: {
  host?: string;
  port?: number;
}): ReportServerHandle {
  const server = Bun.serve({
    hostname: opts?.host ?? DEFAULT_HOST,
    port: opts?.port ?? DEFAULT_PORT,
    fetch: (request) =>
      handleRequest(request).catch((err) =>
        jsonResponse(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        ),
      ),
  });
  const url = `http://${server.hostname}:${server.port}`;
  return {
    url,
    async stop() {
      await server.stop();
    },
  };
}

/**
 * Resolve the right "open this URL" shell command for the given
 * platform. Pulled out as a pure helper so unit tests can exercise the
 * branch table without spawning anything.
 *
 * - macOS → `open <url>`
 * - Windows → `cmd /c start "" <url>` (the empty `""` swallows the title
 *   arg so URLs with `&` don't get misparsed as window titles)
 * - everything else (Linux, *BSD) → `xdg-open <url>`
 */
export function resolveBrowserCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", '""', url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Spawn the OS "open this URL in the default browser" command in
 * detached fire-and-forget mode. On unsupported platforms or when the
 * helper binary isn't present (e.g. headless CI), this silently no-ops
 * — the URL has already been printed to stdout so the user can click
 * it themselves.
 *
 * `unref()` lets the parent process exit independently of the spawned
 * helper if the user ctrl-Cs the server. `stdio: "ignore"` keeps the
 * helper's chatter (e.g. xdg-open's "Opening in firefox") out of our
 * own stdout.
 */
export function openInBrowser(url: string): void {
  const { command, args } = resolveBrowserCommand(process.platform, url);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // Spawn fails on environments without the helper. Not worth
      // crashing the run over — the URL is already printed.
    });
    child.unref();
  } catch {
    // Same rationale — never fail a run because we couldn't pop open
    // a browser tab.
  }
}

/**
 * Spin up an ngrok HTTPS tunnel pointing at the local server, print the
 * public URL, and wire teardown to SIGINT / SIGTERM so the agent process
 * is killed cleanly when the operator hits ctrl-C. Returns the live
 * tunnel handle so callers (currently just `registerServerCommand`) can
 * keep a reference if they need it.
 *
 * Failure mode: any throw from `startNgrokTunnel` (missing binary on
 * PATH, no authtoken, agent crash, poll timeout) is logged and re-
 * thrown — the local report server stays up but the operator sees the
 * error immediately. We don't fall back to "serve locally only" because
 * the operator explicitly asked for a tunnel; quietly skipping would
 * hide the fact that their `--ngrok` flag did nothing.
 */
async function enableNgrokTunnel(port: number): Promise<NgrokTunnel> {
  const tunnel = await startNgrokTunnel({ port });
  console.log(`Public ngrok URL: ${tunnel.publicUrl}`);

  const teardown = (signal: NodeJS.Signals): void => {
    tunnel.stop().finally(() => {
      // After tearing down the tunnel, re-raise the signal so the
      // parent Bun.serve loop sees a real exit instead of dangling.
      process.kill(process.pid, signal);
    });
  };
  // `once` + an inline re-raise rather than `process.exit()` so we don't
  // smother any other shutdown listeners the harness might install.
  process.once("SIGINT", () => teardown("SIGINT"));
  process.once("SIGTERM", () => teardown("SIGTERM"));

  return tunnel;
}

export function registerServerCommand(program: Command): void {
  program
    .command("server")
    .description("Serve a local HTML report browser for .runs artifacts")
    .option("--host <host>", "Host to bind", DEFAULT_HOST)
    .option(
      "--port <port>",
      "Port to bind",
      (value) => Number(value),
      DEFAULT_PORT,
    )
    .option(
      "--ngrok",
      "Expose the server publicly via an ngrok HTTPS tunnel (requires `ngrok` on PATH; supply an authtoken via `NGROK_AUTHTOKEN` env var or `ngrok config add-authtoken`)",
    )
    .action(async (opts: { host: string; port: number; ngrok?: boolean }) => {
      // Before starting the server, clean up any stale runs.
      await scavengeAbandonedRuns();
      const { url } = startReportServer(opts);
      console.log(`Evals report server listening on ${url}`);

      if (opts.ngrok) {
        try {
          await enableNgrokTunnel(opts.port);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to start ngrok tunnel: ${msg}`);
          // Bubble a non-zero exit so scripts can detect the failure;
          // the local server has already been told to stop because
          // process.exit is final and will tear Bun.serve down too.
          process.exitCode = 1;
          return;
        }
      }
    });
}
