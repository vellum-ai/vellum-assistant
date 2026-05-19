/** `evals server` — local HTML report browser for .runs artifacts. */
import { spawn } from "node:child_process";

import type { Command } from "commander";

import { renderReportPage, type ReportPageInput } from "../lib/report-html";
import {
  findExecutionRunId,
  listReportSessions,
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

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/") {
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

  const pageSession = path.match(/^\/sessions\/([^/]+)$/);
  if (pageSession) {
    const sessionId = decodeURIComponent(pageSession[1]);
    const session = await readReportSession(sessionId);
    if (!session) return notFoundPage(`No session ${sessionId}.`);
    return pageResponse({ kind: "session", session });
  }

  return notFoundPage(`No route matches ${url.pathname}.`);
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
    .action((opts: { host: string; port: number }) => {
      const { url } = startReportServer(opts);
      console.log(`Evals report server listening on ${url}`);
    });
}
