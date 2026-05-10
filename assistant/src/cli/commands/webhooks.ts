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
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

export function registerWebhooksCommand(program: Command): void {
  registerCommand(program, {
    name: "webhooks",
    transport: "ipc",
    description: "Manage webhook callback URLs for external integrations",
    build: (webhooks) => {
      webhooks.option("--json", "Machine-readable compact JSON output");
      webhooks.addHelpText(
        "after",
        `
Resolves a stable callback URL that external services (Telegram, Twilio,
email providers, OAuth) should use to reach this assistant.

On platform-managed assistants, this registers a callback route with the
platform gateway. On self-hosted assistants, it uses the configured
ingress.publicBaseUrl.

The webhook path is derived from the type: underscores become path
separators, prefixed with webhooks/.

  telegram       → webhooks/telegram
  twilio_voice   → webhooks/twilio/voice
  twilio_status  → webhooks/twilio/status
  resend         → webhooks/resend

Examples:
  $ assistant webhooks register telegram
  $ assistant webhooks register resend --source "@bot_handle"
  $ assistant webhooks list
  $ assistant webhooks list --json`,
      );

      // -----------------------------------------------------------------------
      // webhooks register <type>
      // -----------------------------------------------------------------------

      webhooks
        .command("register <type>")
        .description(
          "Get a callback URL for a webhook type, registering with the platform if needed",
        )
        .addHelpText(
          "after",
          `
Resolves a callback URL for the given webhook type. On platform-managed
assistants (IS_PLATFORM=true), registers a callback route with the platform
gateway and returns the stable external URL. On self-hosted assistants,
reads ingress.publicBaseUrl from config and appends the webhook path.

Arguments:
  type   The webhook type to register. The path is derived automatically:
         underscores become path separators, prefixed with webhooks/.

           telegram       → webhooks/telegram
           twilio_voice   → webhooks/twilio/voice
           twilio_status  → webhooks/twilio/status
           resend         → webhooks/resend
           mailgun        → webhooks/mailgun
           email          → webhooks/email
           oauth_callback → webhooks/oauth/callback

Options:
  --path <path>     Override the derived webhook path.
  --source <label>  Human-readable source label (e.g. bot handle, phone number)
                    for admin display.

Examples:
  $ assistant webhooks register telegram --source "@my_bot"
  $ assistant webhooks register twilio_voice --json
  $ assistant webhooks register resend --json
  $ assistant webhooks register custom_provider --path webhooks/my-provider --json`,
        )
        .option("--path <path>", "Override the derived webhook path")
        .option(
          "--source <label>",
          "Human-readable source label for admin display (e.g. bot handle, phone number)",
        )
        .action(
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
            if (!r.ok) return exitFromIpcResult({ ok: false, error: r.error, statusCode: r.statusCode }, cmd);
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

      webhooks
        .command("list")
        .description("List registered webhook callback routes")
        .addHelpText(
          "after",
          `
Lists all webhook callback routes registered with the platform for this
assistant. Only available when platform credentials are configured (either
via IS_PLATFORM or 'assistant platform connect').

Self-hosted assistants without platform credentials do not have a persistent
webhook registry — use 'assistant webhooks register <type>' to resolve URLs
on demand.

Examples:
  $ assistant webhooks list
  $ assistant webhooks list --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
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
          if (!r.ok) return exitFromIpcResult({ ok: false, error: r.error, statusCode: r.statusCode }, cmd);
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
        });
    },
  });
}
