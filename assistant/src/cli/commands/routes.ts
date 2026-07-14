/**
 * CLI command group: `assistant routes`
 *
 * Thin IPC wrapper — filesystem scanning logic lives in user-routes-cli.ts.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { routesHelp } from "./routes.help.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveredRoute {
  routePath: string;
  methods: string[];
  description: string | null;
  filePath: string;
  publicUrl: string | null;
}

interface InspectedRoute {
  routePath: string;
  methods: string[];
  description: string | null;
  filePath: string;
  publicUrl: string | null;
  fileSize: number;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMethods(methods: string[]): string {
  return methods.map((m) => (m === "DELETE" ? "DEL" : m)).join(",");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRoutesCommand(program: Command): void {
  registerCommand(program, {
    name: routesHelp.name,
    transport: "ipc",
    description: routesHelp.description,
    build: (routes) => {
      applyCommandHelp(routes, routesHelp);

      subcommand(routes, "list").action(async (opts: { json?: boolean }) => {
        const r = await cliIpcCall<{ routes: DiscoveredRoute[] }>(
          "user_routes_list",
        );
        if (!r.ok) return exitFromIpcResult(r);

        const discovered = r.result!.routes;

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, routes: discovered }));
          return;
        }

        if (discovered.length === 0) {
          log.info(
            "No route handlers found in /workspace/routes/ or /workspace/plugins/<name>/routes/.",
          );
          log.info(
            "Create a .ts or .js file exporting named HTTP method functions (GET, POST, etc.).",
          );
          return;
        }

        log.info("");
        const routeCol = "ROUTE PATH";
        const methodsCol = "METHODS";
        const descCol = "DESCRIPTION";
        const fileCol = "FILE";

        const routeWidth = Math.max(
          routeCol.length,
          ...discovered.map((r) => r.routePath.length),
        );
        const methodsWidth = Math.max(
          methodsCol.length,
          ...discovered.map((r) => formatMethods(r.methods).length),
        );
        const descWidth = Math.max(
          descCol.length,
          ...discovered.map((r) => (r.description ?? "").length),
        );

        const header = [
          routeCol.padEnd(routeWidth),
          methodsCol.padEnd(methodsWidth),
          descCol.padEnd(descWidth),
          fileCol,
        ].join("    ");

        log.info(`  ${header}`);

        for (const route of discovered) {
          const cols = [
            route.routePath.padEnd(routeWidth),
            formatMethods(route.methods).padEnd(methodsWidth),
            (route.description ?? "").padEnd(descWidth),
            route.filePath,
          ].join("    ");
          log.info(`  ${cols}`);
        }

        log.info("");
        const countLabel = discovered.length === 1 ? "route" : "routes";
        const summary = `${discovered.length} ${countLabel}`;
        const firstPublicUrl = discovered.find((r) => r.publicUrl)?.publicUrl;
        if (firstPublicUrl) {
          const publicBase = firstPublicUrl.replace(/\/x\/.*$/, "");
          log.info(`  ${summary} • Public base: ${publicBase}`);
        } else {
          log.info(`  ${summary}`);
        }
        log.info("");
      });

      subcommand(routes, "inspect").action(
        async (routePath: string, opts: { json?: boolean }) => {
          const r = await cliIpcCall<{ route: InspectedRoute }>(
            "user_routes_inspect",
            { body: { path: routePath } },
          );
          if (!r.ok) {
            if (opts.json) {
              console.log(JSON.stringify({ ok: false, error: r.error }));
              process.exitCode = 1;
              return;
            }
            return exitFromIpcResult(r);
          }

          const route = r.result!.route;

          if (opts.json) {
            console.log(JSON.stringify({ ok: true, route }));
            return;
          }

          log.info("");
          log.info(`  Route:       ${route.routePath}`);
          log.info(
            `  Methods:     ${route.methods.join(", ") || "(none)"}  (detected from named exports)`,
          );
          if (route.description) {
            log.info(`  Description: ${route.description}`);
          }
          log.info(`  File:        ${route.filePath}`);
          if (route.publicUrl) {
            log.info(`  Public URL:  ${route.publicUrl}`);
          }
          log.info(`  File Size:   ${route.fileSize} bytes`);
          log.info(`  Modified:    ${route.modifiedAt}`);
          log.info("");
        },
      );
    },
  });
}
