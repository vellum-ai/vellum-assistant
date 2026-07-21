/** Declarative help for the `assistant webhooks` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const webhooksHelp: CliCommandHelp = {
  name: "webhooks",
  description: "Manage webhook callback URLs for external integrations",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
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
  subcommands: [
    {
      name: "register",
      args: "<type>",
      description:
        "Get a callback URL for a webhook type, registering with the platform if needed",
      options: [
        {
          flags: "--path <path>",
          description: "Override the derived webhook path",
        },
        {
          flags: "--source <label>",
          description:
            "Human-readable source label for admin display (e.g. bot handle, phone number)",
        },
      ],
      helpText: `
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
    },
    {
      name: "list",
      description: "List registered webhook callback routes",
      helpText: `
Lists all webhook callback routes registered with the platform for this
assistant. Only available when platform credentials are configured (either
via IS_PLATFORM or 'assistant platform connect').

Self-hosted assistants without platform credentials do not have a persistent
webhook registry — use 'assistant webhooks register <type>' to resolve URLs
on demand.

Examples:
  $ assistant webhooks list
  $ assistant webhooks list --json`,
    },
  ],
};
