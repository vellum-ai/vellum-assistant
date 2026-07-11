/**
 * `assistant platform` — manage Vellum Platform integration.
 *
 * Thin IPC wrapper that delegates all platform operations to the daemon.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { registerPlatformConnectCommand } from "./connect.js";
import { registerPlatformDisconnectCommand } from "./disconnect.js";
import { platformHelp } from "./index.help.js";

interface PlatformStatusResult {
  isPlatform: boolean;
  baseUrl: string;
  assistantId: string;
  hasAssistantApiKey: boolean;
  hasWebhookSecret: boolean;
  available: boolean;
  organizationId: string | null;
  userId: string | null;
  velayTunnel: { connected: boolean; publicUrl: string | null } | null;
}

interface PlatformCreditsResult {
  remaining: number;
  settled: number;
  pending: number;
  unit: "USD";
  stale: boolean;
  as_of: string;
}

export function registerPlatformCommand(program: Command): void {
  registerCommand(program, {
    name: platformHelp.name,
    transport: "ipc",
    description: platformHelp.description,
    build: (platform) => {
      applyCommandHelp(platform, platformHelp);

      // -----------------------------------------------------------------------
      // connect
      // -----------------------------------------------------------------------

      registerPlatformConnectCommand(platform);

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      subcommand(platform, "status").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<PlatformStatusResult>(
            "platform_status",
            {},
          );
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );

          const result = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else {
            log.info(`Platform: ${result.isPlatform}`);
            log.info(`Base URL: ${result.baseUrl || "(not set)"}`);
            log.info(`Assistant ID: ${result.assistantId || "(not set)"}`);
            log.info(
              `Assistant API key: ${result.hasAssistantApiKey ? "set" : "not set"}`,
            );
            log.info(
              `Webhook secret: ${result.hasWebhookSecret ? "set" : "not set (run ensure-registration to provision)"}`,
            );
            log.info(
              `Callback registration available: ${result.available ? "yes" : "no"}`,
            );
            log.info(
              `Organization ID: ${result.organizationId || "(not set)"}`,
            );
            log.info(`User ID: ${result.userId || "(not set)"}`);
            if (result.velayTunnel !== null) {
              const tunnelState = result.velayTunnel.connected
                ? `connected${result.velayTunnel.publicUrl ? ` (${result.velayTunnel.publicUrl})` : ""}`
                : "disconnected";
              log.info(`Velay tunnel: ${tunnelState}`);
            } else {
              log.info(`Velay tunnel: (gateway not running)`);
            }
          }
        },
      );

      // -----------------------------------------------------------------------
      // credits
      // -----------------------------------------------------------------------

      subcommand(platform, "credits").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<PlatformCreditsResult>(
            "platform_credits",
            {},
          );
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );

          const result = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else {
            const staleNote = result.stale
              ? " (pending data may be stale)"
              : "";
            log.info(
              `Remaining: $${result.remaining.toFixed(2)} ${result.unit} (as of ${result.as_of})${staleNote}`,
            );
            log.info(
              `Settled:   $${result.settled.toFixed(2)}   Pending: $${result.pending.toFixed(2)}`,
            );
          }
        },
      );

      // -----------------------------------------------------------------------
      // disconnect
      // -----------------------------------------------------------------------

      registerPlatformDisconnectCommand(platform);

      // -----------------------------------------------------------------------
      // callback-routes
      // -----------------------------------------------------------------------

      const callbackRoutes = subcommand(platform, "callback-routes");

      // -----------------------------------------------------------------------
      // callback-routes register
      // -----------------------------------------------------------------------

      subcommand(callbackRoutes, "register").action(
        async (opts: { path: string; type: string }, cmd: Command) => {
          const r = await cliIpcCall<{
            callbackUrl: string;
            callbackPath: string;
            type: string;
          }>("platform_callback_routes_register", {
            body: { path: opts.path, type: opts.type },
          });
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );

          writeOutput(cmd, { ok: true, ...r.result });

          if (!shouldOutputJson(cmd)) {
            log.info(`Callback route registered: ${r.result!.callbackUrl}`);
          }
        },
      );

      // -----------------------------------------------------------------------
      // callback-routes list
      // -----------------------------------------------------------------------

      subcommand(callbackRoutes, "list").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<{
            routes: Array<{
              id: string;
              assistant_id: string;
              type: string;
              callback_path: string;
              callback_url: string;
            }>;
          }>("platform_callback_routes_list", {});
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );

          const routes = r.result!.routes;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, routes });
          } else {
            if (routes.length === 0) {
              log.info("No callback routes registered.");
            } else {
              log.info(`${routes.length} callback route(s) registered:\n`);
              for (const route of routes) {
                log.info(`  Type: ${route.type}`);
                log.info(`  URL:  ${route.callback_url}`);
                log.info(`  Path: ${route.callback_path}`);
                log.info("");
              }
            }
          }
        },
      );
    },
  });
}
