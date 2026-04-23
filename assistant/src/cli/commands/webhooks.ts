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
  $ assistant webhooks register twilio_voice --json
  $ assistant webhooks register resend --json`,
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
  --path <path>   Override the derived webhook path.

Examples:
  $ assistant webhooks register telegram
  $ assistant webhooks register twilio_voice --json
  $ assistant webhooks register resend --json
  $ assistant webhooks register custom_provider --path webhooks/my-provider --json`,
    )
    .option("--path <path>", "Override the derived webhook path")
    .action(async (type: string, opts: { path?: string }, cmd: Command) => {
      try {
        const webhookPath = opts.path ?? deriveWebhookPath(type);

        let callbackUrl: string;
        let mode: "platform" | "self-hosted";

        if (shouldUsePlatformCallbacks()) {
          // Platform-managed: register callback route
          callbackUrl = await registerCallbackRoute(webhookPath, type);
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
    });
}
