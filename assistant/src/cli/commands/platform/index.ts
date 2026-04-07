import type { Command } from "commander";

import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
} from "../../../inbound/platform-callback-registration.js";
import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyViaDaemon } from "../../lib/daemon-credential-client.js";
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

When IS_PLATFORM=true (platform-managed deployments), external service
callbacks (Telegram webhooks, Twilio webhooks, OAuth redirects) also
route through the platform's gateway proxy via 'callback-routes'.

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
  assistantId         PLATFORM_ASSISTANT_ID — this assistant's platform UUID
  hasInternalApiKey   Whether PLATFORM_INTERNAL_API_KEY is set (boolean,
                      value not disclosed)
  hasAssistantApiKey  Whether a stored assistant API key is available
  hasWebhookSecret    Whether a stored webhook secret is available (needed
                      for email and other inbound webhook channels)
  available           Whether callback registration prerequisites are satisfied
  connected           Whether platform credentials are stored (boolean)
  organizationId      The platform organization ID (from stored credentials)
  userId              The platform user ID (from stored credentials)

Examples:
  $ assistant platform status
  $ assistant platform status --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      try {
        const context = await resolvePlatformCallbackRegistrationContext();

        const storedBaseUrl =
          (await getSecureKeyViaDaemon(
            credentialKey(
              CREDENTIAL_KEYS.baseUrl.service,
              CREDENTIAL_KEYS.baseUrl.field,
            ),
          )) ?? "";
        const hasStoredApiKey = !!(await getSecureKeyViaDaemon(
          credentialKey(
            CREDENTIAL_KEYS.apiKey.service,
            CREDENTIAL_KEYS.apiKey.field,
          ),
        ));
        const organizationId =
          (
            await getSecureKeyViaDaemon(
              credentialKey(
                CREDENTIAL_KEYS.organizationId.service,
                CREDENTIAL_KEYS.organizationId.field,
              ),
            )
          )?.trim() ?? "";
        const userId =
          (
            await getSecureKeyViaDaemon(
              credentialKey(
                CREDENTIAL_KEYS.userId.service,
                CREDENTIAL_KEYS.userId.field,
              ),
            )
          )?.trim() ?? "";

        const hasWebhookSecret = !!(await getSecureKeyViaDaemon(
          credentialKey("vellum", "webhook_secret"),
        ));

        const connected = !!storedBaseUrl && hasStoredApiKey;

        const result = {
          isPlatform: context.isPlatform,
          baseUrl: context.platformBaseUrl,
          assistantId: context.assistantId,
          hasInternalApiKey: context.hasInternalApiKey,
          hasAssistantApiKey: context.hasAssistantApiKey,
          hasWebhookSecret,
          available: context.enabled,
          connected,
          organizationId: organizationId || null,
          userId: userId || null,
        };

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
        } else {
          log.info(`Platform: ${result.isPlatform}`);
          log.info(`Base URL: ${result.baseUrl || "(not set)"}`);
          log.info(`Assistant ID: ${result.assistantId || "(not set)"}`);
          log.info(
            `Internal API key: ${result.hasInternalApiKey ? "set" : "not set"}`,
          );
          log.info(
            `Assistant API key: ${result.hasAssistantApiKey ? "set" : "not set"}`,
          );
          log.info(
            `Webhook secret: ${result.hasWebhookSecret ? "set" : "not set (run ensure-registration to provision)"}`,
          );
          log.info(
            `Callback registration available: ${result.available ? "yes" : "no"}`,
          );
          log.info(`Connected: ${connected}`);
          log.info(`Organization ID: ${organizationId || "(not set)"}`);
          log.info(`User ID: ${userId || "(not set)"}`);
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
webhooks to the correct platform-managed assistant instance. Each route maps a
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
  --path oauth/callback             --type oauth

Requires a platform-managed environment (IS_PLATFORM=true) with
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
              "Platform callbacks not available — missing platform registration context",
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
