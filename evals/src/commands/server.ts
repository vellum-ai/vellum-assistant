/** `evals server` — local HTML report browser for .runs artifacts. */
import type { Command } from "commander";

import { renderReportPage } from "../lib/report-html";
import { listReportRuns, readReportRun } from "../lib/report-data";

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

function notFound(): Response {
  return htmlResponse("<h1>Not found</h1>", 404);
}

async function renderHome(selectedRunId?: string): Promise<Response> {
  const runs = await listReportRuns();
  const selectedRun = selectedRunId
    ? await readReportRun(selectedRunId)
    : runs[0]
      ? await readReportRun(runs[0].runId)
      : undefined;
  return htmlResponse(renderReportPage({ runs, selectedRun }));
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "") return renderHome();
  if (url.pathname === "/api/runs") return jsonResponse(await listReportRuns());

  const apiRun = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (apiRun)
    return jsonResponse(await readReportRun(decodeURIComponent(apiRun[1])));

  const pageRun = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (pageRun) return renderHome(decodeURIComponent(pageRun[1]));

  return notFound();
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
