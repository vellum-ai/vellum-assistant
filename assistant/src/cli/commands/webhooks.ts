/**
 * `assistant webhooks` — unified webhook URL management.
 *
 * Abstracts over the platform/self-hosted split so skills and setup flows
 * can get a callback URL in one command without branching on IS_PLATFORM,
 * loading the public-ingress skill, or calling `platform callback-routes
 * register` directly.
 *
 * Platform-managed:  registers a callback route and returns the platform URL.
 * Self-hosted:       resolves ingress.publicBaseUrl and appends the path.
 */

import type { Command } from "commander";

import { getConfig } from "../../config/loader.js";
import {
  registerCallbackRoute,
  resolvePlatformCallbackRegistrationContext,
  shouldUsePlatformCallbacks,
} from "../../inbound/platform-callback-registration.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Type → path derivation
// ---------------------------------------------------------------------------

/**
 * Derive the webhook path from the type name.
 *
 * Convention: underscores become path separators, prefixed with `webhooks/`.
 *   telegram       → webhooks/telegram
 *   twilio_voice   → webhooks/twilio/voice
 *   twilio_status  → webhooks/twilio/status
 *   resend         → webhooks/resend
 *   oauth_callback → webhooks/oauth/callback
 */
function deriveWebhookPath(type: string): string {
  return `webhooks/${type.replace(/_/g, "/")}`;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program
    .command("webhooks")
    .description("Manage webhook callback URLs for external integrations")
    .option("--json", "Machine-readable compact JSON output");

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

  // ---------------------------------------------------------------------------
  // webhooks register <type>
  // ---------------------------------------------------------------------------

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
        try {
          const webhookPath = opts.path ?? deriveWebhookPath(type);

          let callbackUrl: string;
          let mode: "platform" | "self-hosted";

          if (shouldUsePlatformCallbacks()) {
            // Platform-managed: register callback route
            callbackUrl = await registerCallbackRoute(
              webhookPath,
              type,
              opts.source,
            );
            mode = "platform";
          } else {
            // Self-hosted: use ingress.publicBaseUrl
            const config = getConfig();
            const baseUrl = getPublicBaseUrl(config);
            callbackUrl = `${baseUrl}/${webhookPath}`;
            mode = "self-hosted";
          }

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              callbackUrl,
              type,
              path: webhookPath,
              mode,
            });
          } else {
            // Plain mode: emit only the URL so callers can capture it with $()
            process.stdout.write(callbackUrl + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: false, error: message });
          } else {
            log.error(message);
          }
          process.exitCode = 1;
        }
      },
    );

  // ---------------------------------------------------------------------------
  // webhooks list
  // ---------------------------------------------------------------------------

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
      try {
        const context = await resolvePlatformCallbackRegistrationContext();
        if (!context.platformBaseUrl || !context.authHeader) {
          const errorMsg =
            "Self-hosted webhook listing coming soon. Use 'assistant webhooks register <type>' to resolve URLs on demand.";
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: false, error: errorMsg });
          } else {
            log.error(errorMsg);
          }
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
          const errorMsg = `Failed to list webhook routes (HTTP ${response.status}): ${detail}`;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: false, error: errorMsg });
          } else {
            log.error(errorMsg);
          }
          process.exitCode = 1;
          return;
        }

        const routes = (await response.json()) as Array<{
          id: string;
          assistant_id: string;
          type: string;
          callback_path: string;
          callback_url: string;
          source_identifier: string | null;
        }>;

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { ok: true, routes });
        } else {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { ok: false, error: message });
        } else {
          log.error(message);
        }
        process.exitCode = 1;
      }
    });
}
