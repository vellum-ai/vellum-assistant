/**
 * `assistant platform` — manage Vellum Platform integration.
 *
 * Thin IPC wrapper that delegates all platform operations to the daemon.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { registerPlatformConnectCommand } from "./connect.js";
import { registerPlatformDisconnectCommand } from "./disconnect.js";

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
    name: "platform",
    transport: "ipc",
    description: "Manage Vellum Platform integration",
    build: (platform) => {
      platform.option("--json", "Machine-readable compact JSON output");

      platform.addHelpText(
        "after",
        `
The platform subsystem manages the connection to Vellum Platform. Use
'connect', 'status', and 'disconnect' to manage platform credentials.
Any assistant using the managed LLM proxy can use these commands.

External service callbacks (Telegram webhooks, Twilio webhooks, email,
OAuth redirects) route through the platform's gateway proxy via
'callback-routes'. Works for both platform-managed and self-hosted
assistants.

Examples:
  $ assistant platform status --json
  $ assistant platform credits --json
  $ assistant platform connect
  $ assistant platform disconnect
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json`,
      );

      // -----------------------------------------------------------------------
      // connect
      // -----------------------------------------------------------------------

      registerPlatformConnectCommand(platform);

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      platform
        .command("status")
        .description(
          "Show current platform deployment context and connection status",
        )
        .addHelpText(
          "after",
          `
Reads platform-related environment variables and stored credentials to report
the current platform deployment context and connection state.

Fields:
  isPlatform          Whether IS_PLATFORM is set (boolean)
  baseUrl             VELLUM_PLATFORM_URL — the platform gateway base URL
  assistantId         This assistant's platform UUID
  hasAssistantApiKey  Whether a stored assistant API key is available
  hasWebhookSecret    Whether a stored webhook secret is available (needed
                      for email and other inbound webhook channels)
  available           Whether callback registration prerequisites are satisfied
  organizationId      The platform organization ID (from stored credentials)
  userId              The platform user ID (from stored credentials)
  velayTunnel         Live Velay tunnel status from the gateway IPC socket
                      (null when the gateway is not running)

Examples:
  $ assistant platform status
  $ assistant platform status --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
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
        });

      // -----------------------------------------------------------------------
      // credits
      // -----------------------------------------------------------------------

      platform
        .command("credits")
        .description("Show the organization's remaining credit balance")
        .addHelpText(
          "after",
          `
Fetches the org's credit balance from the platform billing summary.

Fields:
  remaining   Effective balance (settled minus pending charges) in USD
  settled     On-ledger balance in USD
  pending     Estimated pending compute charges not yet settled, in USD
  unit        Balance currency (USD)
  stale       True when pending-charge data may be stale or unavailable
  as_of       When this balance was read (response receipt time)

Combine with 'assistant usage daily' to compute runway (remaining divided
by rolling daily average) and warn before credits run out.

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform credits
  $ assistant platform credits --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
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
        });

      // -----------------------------------------------------------------------
      // disconnect
      // -----------------------------------------------------------------------

      registerPlatformDisconnectCommand(platform);

      // -----------------------------------------------------------------------
      // callback-routes
      // -----------------------------------------------------------------------

      const callbackRoutes = platform
        .command("callback-routes")
        .description("Manage platform callback route registrations");

      callbackRoutes.addHelpText(
        "after",
        `
Callback routes tell the platform gateway how to forward inbound provider
webhooks to the correct assistant instance. Each route maps a callback path
and type to a stable external URL that external services (Telegram, Twilio,
email, OAuth providers) should use.

Examples:
  $ assistant platform callback-routes list
  $ assistant platform callback-routes list --json
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant platform callback-routes register --path webhooks/twilio/voice --type twilio_voice --json`,
      );

      // -----------------------------------------------------------------------
      // callback-routes register
      // -----------------------------------------------------------------------

      callbackRoutes
        .command("register")
        .description("Register a callback route with the platform gateway")
        .requiredOption(
          "--path <path>",
          "Callback path (e.g. webhooks/telegram, webhooks/twilio/voice)",
        )
        .requiredOption(
          "--type <type>",
          "Route type identifier (e.g. telegram, twilio_voice, twilio_status, oauth)",
        )
        .addHelpText(
          "after",
          `
Registers a callback route with the platform's internal gateway endpoint so
the platform knows how to forward inbound provider webhooks to this
platform-managed assistant instance.

Arguments:
  --path    The path portion after the ingress base URL. Leading/trailing
            slashes are stripped by the platform.
  --type    The route type identifier used by the platform to classify and
            route the callback.

Known callback path/type combinations:
  --path webhooks/telegram          --type telegram
  --path webhooks/twilio/voice      --type twilio_voice
  --path webhooks/twilio/status     --type twilio_status
  --path webhooks/resend            --type resend
  --path webhooks/mailgun           --type mailgun
  --path webhooks/email             --type email
  --path oauth/callback             --type oauth

Works for both platform-managed and self-hosted assistants. Requires
VELLUM_PLATFORM_URL and a platform assistant ID. Returns the platform-provided
stable callback URL that external services should use.

Examples:
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant platform callback-routes register --path webhooks/twilio/voice --type twilio_voice --json`,
        )
        .action(async (opts: { path: string; type: string }, cmd: Command) => {
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
        });

      // -----------------------------------------------------------------------
      // callback-routes list
      // -----------------------------------------------------------------------

      callbackRoutes
        .command("list")
        .description("List registered callback routes for this assistant")
        .addHelpText(
          "after",
          `
Lists all callback routes registered with the platform for this assistant.
Shows the route type, callback URL, and path for each registered webhook.

Requires platform credentials (run 'assistant platform connect' first or
ensure IS_PLATFORM and VELLUM_PLATFORM_URL are set and credentials are stored).

Examples:
  $ assistant platform callback-routes list
  $ assistant platform callback-routes list --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
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
        });
    },
  });
}
