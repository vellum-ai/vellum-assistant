/** `evals server` — local HTML report browser for .runs artifacts. */
import type { Command } from "commander";

import { renderReportPage, type ReportPageInput } from "../lib/report-html";
import {
  findExecutionRunId,
  listReportSessions,
  readReportRun,
  readReportSession,
  readTestInSession,
} from "../lib/report-data";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3005;

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
      const server = Bun.serve({
        hostname: opts.host,
        port: opts.port,
        fetch: (request) =>
          handleRequest(request).catch((err) =>
            jsonResponse(
              { error: err instanceof Error ? err.message : String(err) },
              500,
            ),
          ),
      });
      console.log(
        `Evals report server listening on http://${server.hostname}:${server.port}`,
      );
    });
}
