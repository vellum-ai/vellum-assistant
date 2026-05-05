import type { Command } from "commander";

import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../../inbound/platform-callback-registration.js";
import { ipcGetVelayStatus } from "../../../ipc/gateway-client.js";
import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { CREDENTIAL_KEYS, registerPlatformConnectCommand } from "./connect.js";
import { registerPlatformDisconnectCommand } from "./disconnect.js";

export function registerPlatformCommand(program: Command): void {
  const platform = program
    .command("platform")
    .description("Manage Vellum Platform integration")
    .option("--json", "Machine-readable compact JSON output");

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
  $ assistant platform connect
  $ assistant platform disconnect
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json`,
  );

  // ---------------------------------------------------------------------------
  // connect — store platform credentials and validate the connection
  // ---------------------------------------------------------------------------

  registerPlatformConnectCommand(platform);

  // ---------------------------------------------------------------------------
  // status — deployment context and connection status combined
  // ---------------------------------------------------------------------------

  platform
    .command("status")
    .description(
      "Show current platform deployment context and connection status",
    )
    .addHelpText(
      "after",
      `
Reads platform-related environment variables and stored credentials to report
the current platform deployment context and connection state. Does not
require the assistant to be running.

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
      try {
        const [context, velayTunnel] = await Promise.all([
          resolvePlatformCallbackRegistrationContext(),
          ipcGetVelayStatus().catch(() => null),
        ]);

        const organizationId =
          (
            await getSecureKeyAsync(
              credentialKey(
                CREDENTIAL_KEYS.organizationId.service,
                CREDENTIAL_KEYS.organizationId.field,
              ),
            )
          )?.trim() ?? "";
        const userId =
          (
            await getSecureKeyAsync(
              credentialKey(
                CREDENTIAL_KEYS.userId.service,
                CREDENTIAL_KEYS.userId.field,
              ),
            )
          )?.trim() ?? "";

        const hasWebhookSecret = !!(await getSecureKeyAsync(
          credentialKey("vellum", "webhook_secret"),
        ));

        const result = {
          isPlatform: context.isPlatform,
          baseUrl: context.platformBaseUrl,
          assistantId: context.assistantId,
          hasAssistantApiKey: context.hasAssistantApiKey,
          hasWebhookSecret,
          available: context.enabled,
          organizationId: organizationId || null,
          userId: userId || null,
          velayTunnel,
        };

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
          log.info(`Organization ID: ${organizationId || "(not set)"}`);
          log.info(`User ID: ${userId || "(not set)"}`);
          if (result.velayTunnel !== null) {
            const tunnelState = result.velayTunnel.connected
              ? `connected${result.velayTunnel.publicUrl ? ` (${result.velayTunnel.publicUrl})` : ""}`
              : "disconnected";
            log.info(`Velay tunnel: ${tunnelState}`);
          } else {
            log.info(`Velay tunnel: (gateway not running)`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // disconnect — remove stored platform credentials
  // ---------------------------------------------------------------------------

  registerPlatformDisconnectCommand(platform);

  // ---------------------------------------------------------------------------
  // callback-routes
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // callback-routes register
  // ---------------------------------------------------------------------------

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
      try {
        const context = await resolvePlatformCallbackRegistrationContext();
        if (!context.enabled) {
          writeOutput(cmd, {
            ok: false,
            error:
              "Platform callbacks not available — missing platform base URL, assistant ID, or API key. Run 'assistant platform connect' or ensure credentials are configured.",
          });
          process.exitCode = 1;
          return;
        }

        const callbackUrl = await registerCallbackRoute(opts.path, opts.type);

        writeOutput(cmd, {
          ok: true,
          callbackUrl,
          callbackPath: opts.path,
          type: opts.type,
        });

        if (!shouldOutputJson(cmd)) {
          log.info(`Callback route registered: ${callbackUrl}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // callback-routes list
  // ---------------------------------------------------------------------------

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
      try {
        const context = await resolvePlatformCallbackRegistrationContext();
        if (!context.platformBaseUrl || !context.authHeader) {
          writeOutput(cmd, {
            ok: false,
            error:
              "Platform credentials not available — run 'assistant platform connect' or set VELLUM_PLATFORM_URL",
          });
          process.exitCode = 1;
          return;
        }

        const url = `${context.platformBaseUrl}/v1/internal/gateway/callback-routes/`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: context.authHeader,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          writeOutput(cmd, {
            ok: false,
            error: `Failed to list callback routes (HTTP ${response.status}): ${detail}`,
          });
          process.exitCode = 1;
          return;
        }

        const routes = (await response.json()) as Array<{
          id: string;
          assistant_id: string;
          type: string;
          callback_path: string;
          callback_url: string;
        }>;

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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
