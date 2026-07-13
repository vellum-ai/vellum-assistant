/**
 * `assistant webhooks` — unified webhook URL management.
 *
 * Thin IPC wrapper that delegates webhook operations to the daemon.
 *
 * Platform-managed:  daemon registers a callback route and returns the platform URL.
 * Self-hosted:       daemon resolves ingress.publicBaseUrl and appends the path.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { webhooksHelp } from "./webhooks.help.js";

export function registerWebhooksCommand(program: Command): void {
  registerCommand(program, {
    name: webhooksHelp.name,
    transport: "ipc",
    description: webhooksHelp.description,
    build: (webhooks) => {
      applyCommandHelp(webhooks, webhooksHelp);

      // -----------------------------------------------------------------------
      // webhooks register <type>
      // -----------------------------------------------------------------------

      subcommand(webhooks, "register").action(
        async (
          type: string,
          opts: { path?: string; source?: string },
          cmd: Command,
        ) => {
          const r = await cliIpcCall<{
            callbackUrl: string;
            type: string;
            path: string;
            mode: "platform" | "self-hosted";
          }>("webhooks_register", {
            body: {
              type,
              path: opts.path,
              source: opts.source,
            },
          });
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, ...r.result });
          } else {
            process.stdout.write(r.result!.callbackUrl + "\n");
          }
        },
      );

      // -----------------------------------------------------------------------
      // webhooks list
      // -----------------------------------------------------------------------

      subcommand(webhooks, "list").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<{
            routes: Array<{
              id: string;
              assistant_id: string;
              type: string;
              callback_path: string;
              callback_url: string;
              source_identifier: string | null;
            }>;
          }>("webhooks_list", {});
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, routes: r.result!.routes });
          } else {
            const routes = r.result!.routes;
            if (routes.length === 0) {
              log.info("No webhook routes registered.");
            } else {
              log.info(`${routes.length} webhook route(s) registered:\n`);
              for (const route of routes) {
                log.info(`  Type:   ${route.type}`);
                log.info(`  URL:    ${route.callback_url}`);
                if (route.source_identifier) {
                  log.info(`  Source: ${route.source_identifier}`);
                }
                log.info("");
              }
            }
          }
        },
      );
    },
  });
}
