import type { Command } from "commander";

import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../inbound/platform-callback-registration.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

export function registerPlatformCommand(program: Command): void {
  const platform = program
    .command("platform")
    .description("Manage platform integration for containerized deployments")
    .option("--json", "Machine-readable compact JSON output");

  platform.addHelpText(
    "after",
    `
The platform subsystem manages callback routing, containerized deployment
context, and webhook forwarding for assistants running inside platform
containers. When IS_CONTAINERIZED=true with a configured VELLUM_PLATFORM_URL
and PLATFORM_ASSISTANT_ID, external service callbacks (Telegram webhooks,
Twilio webhooks, OAuth redirects) route through the platform's gateway proxy
instead of hitting the assistant directly.

Examples:
  $ assistant platform status --json
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant platform status`,
  );

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  platform
    .command("status")
    .description("Show current platform deployment context")
    .addHelpText(
      "after",
      `
Reads platform-related environment variables and returns the current
containerized deployment context. Does not require the assistant to be
running.

Fields:
  containerized       Whether IS_CONTAINERIZED is set (boolean)
  baseUrl             Platform base URL from env or stored managed credentials
  assistantId         Assistant platform UUID from env or stored managed credentials
  hasInternalApiKey   Whether PLATFORM_INTERNAL_API_KEY is set (boolean,
                      value not disclosed)
  hasAssistantApiKey  Whether a stored assistant API key is available
  available           Whether callback registration prerequisites are satisfied

Examples:
  $ assistant platform status
  $ assistant platform status --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const context = await resolvePlatformCallbackRegistrationContext();
      const result = {
        containerized: context.containerized,
        baseUrl: context.platformBaseUrl,
        assistantId: context.assistantId,
        hasInternalApiKey: context.hasInternalApiKey,
        hasAssistantApiKey: context.hasAssistantApiKey,
        available: context.enabled,
      };

      writeOutput(cmd, result);

      if (!shouldOutputJson(cmd)) {
        log.info(`Containerized: ${result.containerized}`);
        log.info(`Base URL: ${result.baseUrl || "(not set)"}`);
        log.info(`Assistant ID: ${result.assistantId || "(not set)"}`);
        log.info(
          `Internal API key: ${result.hasInternalApiKey ? "set" : "not set"}`,
        );
        log.info(
          `Assistant API key: ${result.hasAssistantApiKey ? "set" : "not set"}`,
        );
        log.info(
          `Callback registration available: ${result.available ? "yes" : "no"}`,
        );
      }
    });

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
webhooks to the correct containerized assistant instance. Each route maps a
callback path and type to a stable external URL that external services
(Telegram, Twilio, OAuth providers) should use.

Examples:
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
containerized assistant instance.

Arguments:
  --path    The path portion after the ingress base URL. Leading/trailing
            slashes are stripped by the platform.
  --type    The route type identifier used by the platform to classify and
            route the callback.

Known callback path/type combinations:
  --path webhooks/telegram          --type telegram
  --path webhooks/twilio/voice      --type twilio_voice
  --path webhooks/twilio/status     --type twilio_status
  --path oauth/callback             --type oauth

Requires a containerized environment (IS_CONTAINERIZED=true) with
VELLUM_PLATFORM_URL and PLATFORM_ASSISTANT_ID configured. Returns the
platform-provided stable callback URL that external services should use.

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
              "Platform callbacks not available — missing containerized platform registration context",
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
}
