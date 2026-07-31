/** Declarative help for the `assistant platform` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

export const platformHelp: CliCommandHelp = {
  name: "platform",
  description: "Manage Vellum Platform integration",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
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
  $ assistant platform subscription --json
  $ assistant platform plans --json
  $ assistant platform invoices list --json
  $ assistant platform connect
  $ assistant platform disconnect
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json`,
  subcommands: [
    {
      name: "connect",
      description:
        "Connect this assistant to the Vellum Platform by storing credentials",
      helpText: `
Initiates a platform connection flow. Emits a signal for connected clients
to show a platform login UI where the user can sign in and store credentials.

Use 'assistant platform status' to check the current connection state and
'assistant platform disconnect' to remove stored credentials.

Examples:
  $ assistant platform connect
  $ assistant platform connect --json`,
    },
    {
      name: "status",
      description:
        "Show current platform deployment context and connection status",
      helpText: `
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

For the Velay tunnel state (only relevant for Twilio webhooks and live
voice/audio), use 'assistant gateway status' instead.

Examples:
  $ assistant platform status
  $ assistant platform status --json`,
    },
    {
      name: "credits",
      description: "Show the organization's remaining credit balance",
      helpText: `
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
    },
    {
      name: "subscription",
      description:
        "Show the organization's current plan and subscription state",
      helpText: `
Fetches the org's plan and subscription state from the platform. Answers
"what plan am I on?".

Fields:
  planId              Current plan: "base" or "pro"
  status              Stripe subscription status (e.g. active, past_due) or
                      null on the base plan
  renewalDate         When the current period ends / the plan renews (ISO
                      8601), or null on the base plan
  currentPeriodEnd    Same as renewalDate; mirrors the platform field
  cancelAtPeriodEnd   True when the subscription is set to cancel at period end
  cancelAt            When the subscription cancels (ISO 8601), or null
  selectedCreditTier  The selected Pro credit bundle tier, or null
  package             The named Pro package pin ({ key, name, version,
                      customized }), or null
  entitlements        Plan-gated features ({ managedEmail, phoneNumber })

For the credit balance (not the plan), use 'assistant platform credits'. For
plan pricing, use 'assistant platform plans'.

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform subscription
  $ assistant platform subscription --json`,
    },
    {
      name: "plans",
      description: "Show the plan catalog with pricing",
      helpText: `
Fetches the platform plan catalog. Answers "how much does each plan cost?".

Returns a "plans" array. Each entry has an "id" ("base" or "pro"), "name",
"billing_interval", and "included_features". The base plan carries
"price_cents"; the pro plan carries "base_price_cents" plus "machine_tiers",
"storage_tiers", "credit_tiers", and "packages" (each tier priced in cents).

For the org's OWN plan (not the catalog), use 'assistant platform
subscription'. For the credit balance, use 'assistant platform credits'.

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform plans
  $ assistant platform plans --json`,
    },
    {
      name: "invoices",
      description: "Read the organization's Stripe invoice history",
      helpText: `
Invoices are read from the platform's billing invoices endpoint using this
assistant's platform API key. Amounts are Stripe-scaled integers; see
'assistant platform invoices list --help' for the scaling rules. 'created'
is a Unix timestamp in seconds.

The platform returns one page of invoices at a time (newest first). When
the response's 'has_more' is true, pass the last invoice's id via
--starting-after to fetch the next (older) page.

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform invoices list --json
  $ assistant platform invoices list --starting-after in_1AbCdEfGh
  $ assistant platform invoices get in_1AbCdEfGh --json`,
      subcommands: [
        {
          name: "list",
          description:
            "List one page of the organization's Stripe invoices, newest first",
          options: [
            {
              flags: "--starting-after <invoice-id>",
              description:
                "Cursor: return invoices older than this invoice id (use the last id from the previous page)",
            },
          ],
          helpText: `
Fetches one page of the org's Stripe invoice history from the platform,
newest first.

Fields:
  invoices            One page of invoices, each with the fields below
  id                  Stripe invoice ID; pass it to 'assistant platform
                      invoices get' or to --starting-after
  number              Human-readable invoice number, or null
  status              Stripe status (draft, open, paid, uncollectible,
                      void), or null
  currency            Lowercase ISO currency code (e.g. usd)
  amount_due          Amount due as a Stripe-scaled integer: divide by
                      100 for most currencies, by 1 for Stripe
                      zero-decimal currencies (e.g. JPY, KRW), and by
                      1000 for three-decimal ones (e.g. BHD); ISK, HUF,
                      TWD, and UGX are two-decimal for charges and
                      invoices (Stripe treats them as zero-decimal
                      only for payouts)
  amount_paid         Amount paid, same Stripe scaling as amount_due
  amount_remaining    Amount still owed, same Stripe scaling as amount_due
  created             Creation time as a Unix timestamp in seconds
  hosted_invoice_url  Link to the hosted Stripe invoice page, or null
  invoice_pdf         Link to the invoice PDF, or null
  has_more            True when older invoices exist beyond this page;
                      fetch them with --starting-after

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform invoices list --json
  $ assistant platform invoices list --starting-after in_1AbCdEfGh --json`,
        },
        {
          name: "get",
          description: "Show a single Stripe invoice by ID",
          arguments: [
            {
              name: "<invoice-id>",
              description:
                "Stripe invoice ID (e.g. in_1AbCdEfGh); run 'assistant platform invoices list' to find it",
            },
          ],
          helpText: `
The platform has no per-invoice endpoint, so the assistant pages through
the org's invoice list (newest first) until the ID matches. The lookup
searches the most recent 2,500 invoices (25 pages) and errors if the ID
is not found within that range.

Requires platform credentials (run 'assistant platform connect' first or
ensure VELLUM_PLATFORM_URL is set and credentials are stored).

Examples:
  $ assistant platform invoices get in_1AbCdEfGh
  $ assistant platform invoices get in_1AbCdEfGh --json`,
        },
      ],
    },
    {
      name: "disconnect",
      description:
        "Disconnect from the Vellum Platform by removing stored credentials",
      helpText: `
Removes all stored platform credentials from the assistant's secure
credential store. After disconnecting, platform-managed features (managed
proxy, managed OAuth, callback routing) will no longer be available until
you reconnect with 'assistant platform connect'.

Use 'assistant platform status' to check the current connection state
before disconnecting.

Examples:
  $ assistant platform disconnect
  $ assistant platform disconnect --json`,
    },
    {
      name: "callback-routes",
      description: "Manage platform callback route registrations",
      helpText: `
Callback routes tell the platform gateway how to forward inbound provider
webhooks to the correct assistant instance. Each route maps a callback path
and type to a stable external URL that external services (Telegram, Twilio,
email, OAuth providers) should use.

Examples:
  $ assistant platform callback-routes list
  $ assistant platform callback-routes list --json
  $ assistant platform callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant platform callback-routes register --path webhooks/twilio/voice --type twilio_voice --json`,
      subcommands: [
        {
          name: "register",
          description: "Register a callback route with the platform gateway",
          options: [
            {
              flags: "--path <path>",
              description:
                "Callback path (e.g. webhooks/telegram, webhooks/twilio/voice)",
              required: true,
            },
            {
              flags: "--type <type>",
              description:
                "Route type identifier (e.g. telegram, twilio_voice, twilio_status, oauth)",
              required: true,
            },
          ],
          helpText: `
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
        },
        {
          name: "list",
          description: "List registered callback routes for this assistant",
          helpText: `
Lists all callback routes registered with the platform for this assistant.
Shows the route type, callback URL, and path for each registered webhook.

Requires platform credentials (run 'assistant platform connect' first or
ensure IS_PLATFORM and VELLUM_PLATFORM_URL are set and credentials are stored).

Examples:
  $ assistant platform callback-routes list
  $ assistant platform callback-routes list --json`,
        },
      ],
    },
  ],
};
