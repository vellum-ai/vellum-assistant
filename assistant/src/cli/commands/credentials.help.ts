/** Declarative help for the `assistant credentials` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const credentialsHelp: CliCommandHelp = {
  name: "credentials",
  description:
    "Manage credentials in the encrypted vault (API keys, tokens, passwords)",
  options: [
    {
      flags: "--json",
      description: "Machine-readable compact JSON output",
    },
  ],
  helpText: `
Credentials are identified by --service and --field flags, matching the
storage convention used internally (credential/{service}/{field}):

  --service twilio --field account_sid        Twilio account SID
  --service twilio --field auth_token         Twilio auth token
  --service telegram --field bot_token        Telegram bot token
  --service slack_channel --field bot_token   Slack channel bot token
  --service github --field token              GitHub personal access token

Secrets are stored in AES-256-GCM encrypted storage. Metadata (policy,
timestamps, labels) is tracked separately and never contains secret values.

Examples:
  $ assistant credentials list
  $ assistant credentials list --search twilio
  $ assistant credentials set --service twilio --field account_sid AC1234567890
  $ assistant credentials inspect --service twilio --field account_sid
  $ assistant credentials reveal --service twilio --field account_sid
  $ assistant credentials delete --service twilio --field auth_token`,
  subcommands: [
    {
      name: "list",
      description:
        "List all stored credentials with metadata and masked values",
      options: [
        {
          flags: "--search <query>",
          description:
            "Filter credentials by substring match on service, field, label, or description",
        },
      ],
      helpText: `
Lists all credentials in the vault. Each entry includes the same fields as
"inspect" — scrubbed value, timestamps, policy, and metadata.

The --search flag filters results by case-insensitive substring match against
the credential's service name, field name, label, or description. For example, --search
twilio matches twilio:account_sid, twilio:auth_token, and twilio:phone_number.

Returns an array of credential objects. Empty array if no credentials exist
or none match the search query.

Examples:
  $ assistant credentials list
  $ assistant credentials list --search twilio
  $ assistant credentials list --search bot_token
  $ assistant credentials list --json`,
    },
    {
      name: "status",
      description: "Show the active credential backend and its configuration",
      helpText: `
Shows which credential storage backend this process is using and backend-specific
path or connection details. Run this to diagnose credential lookup mismatches —
for example, when the CLI and the daemon are reading from different stores.

Backend types:
  encrypted-store   Direct file read from keys.enc (standalone CLI, no daemon)
  ces-rpc           Delegates to the running CES process via stdio RPC (daemon)
  ces-http          Delegates to CES sidecar over HTTP (containerized/Docker mode)

Also shows the CREDENTIAL_SECURITY_DIR, GATEWAY_SECURITY_DIR, and
VELLUM_WORKSPACE_DIR env vars so you can confirm which instance directory this
process is scoped to.

Examples:
  $ assistant credentials status
  $ assistant credentials status --json`,
    },
    {
      name: "set",
      args: "<value>",
      description: "Store a secret and create or update its metadata",
      options: [
        {
          flags: "--service <service>",
          description: "Service namespace (e.g. google)",
          required: true,
        },
        {
          flags: "--field <field>",
          description: "Field name (e.g. client_secret)",
          required: true,
        },
        {
          flags: "--label <label>",
          description: 'Human-friendly label (e.g. "prod", "work")',
        },
        {
          flags: "--description <description>",
          description: "What this credential is used for",
        },
        {
          flags: "--allowed-tools <tools>",
          description:
            "Comma-separated tool names that may use this credential",
        },
      ],
      helpText: `
Arguments:
  value   The secret value to store

If the credential already exists, the secret is overwritten and metadata is
updated with any provided flags. Omitted flags leave existing metadata intact.

Examples:
  $ assistant credentials set --service twilio --field account_sid AC1234567890
  $ assistant credentials set --service fal --field api_key key_live_abc --label "fal-prod" --description "Image generation"
  $ assistant credentials set --service github --field token ghp_abc --allowed-tools "bash,host_bash"`,
    },
    {
      name: "delete",
      description: "Remove a secret and its metadata from the vault",
      options: [
        {
          flags: "--service <service>",
          description: "Service namespace",
          required: true,
        },
        {
          flags: "--field <field>",
          description: "Field name",
          required: true,
        },
      ],
      helpText: `
Deletes both the encrypted secret and all associated metadata (policy,
timestamps, injection templates). This action cannot be undone.

Examples:
  $ assistant credentials delete --service twilio --field auth_token
  $ assistant credentials delete --service github --field token`,
    },
    {
      name: "inspect",
      args: "[id]",
      description: "Show metadata and a masked preview of a stored credential",
      options: [
        {
          flags: "--service <service>",
          description: "Service namespace",
        },
        {
          flags: "--field <field>",
          description: "Field name",
        },
      ],
      helpText: `
Arguments:
  id   (optional) Credential UUID for lookup by ID

Shows everything known about a credential without revealing the secret value.
The secret is masked to show only the last 4 characters (e.g. ****c123).

Displayed fields include: label, creation/update timestamps, allowed tools,
allowed domains, OAuth2 scopes, account info, and injection template count.

Use --service and --field to look up by service/field, or pass a UUID as a
positional argument. One of the two forms is required.

Examples:
  $ assistant credentials inspect --service twilio --field account_sid
  $ assistant credentials inspect 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials inspect --json --service slack_channel --field bot_token`,
    },
    {
      name: "reveal",
      args: "[id]",
      description: "Print the plaintext value of a credential",
      options: [
        {
          flags: "--service <service>",
          description: "Service namespace",
        },
        {
          flags: "--field <field>",
          description: "Field name",
        },
        {
          flags: "--for-chat",
          description:
            "Print a chat-safe reveal chip token instead of the plaintext",
        },
      ],
      helpText: `
Arguments:
  id   (optional) Credential UUID for lookup by ID

Prints the raw secret value to stdout for piping into other tools. In JSON
mode the value is returned as {"ok": true, "value": "..."}. In human mode
only the bare secret is printed (no labels or decoration) so it can be
captured with shell substitution.

Use --service and --field to look up by service/field, or pass a UUID as a
positional argument. One of the two forms is required.

With --for-chat, the plaintext is never printed: the command outputs the
credential's redaction chip token instead. Paste that token into a chat
reply to show the credential as a click-to-reveal chip — use it whenever
the goal is to SHOW a credential to the user in conversation rather than
to pipe its value into another tool. Requires the chat-credential-reveal
feature flag.

Examples:
  $ assistant credentials reveal --service twilio --field auth_token
  $ assistant credentials reveal 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials reveal --json --service twilio --field account_sid
  $ assistant credentials reveal --for-chat --service twilio --field auth_token
  $ export TWILIO_TOKEN=$(assistant credentials reveal --service twilio --field auth_token)`,
    },
    {
      name: "prompt",
      description:
        "Securely prompt the user for a credential via the app UI and store it",
      options: [
        {
          flags: "--service <service>",
          description: "Service namespace (e.g. sentry)",
          required: true,
        },
        {
          flags: "--field <field>",
          description: "Field name (e.g. auth_token)",
          required: true,
        },
        {
          flags: "--label <label>",
          description: "Display label for the prompt UI",
          required: true,
        },
        {
          flags: "--description <description>",
          description: "Context shown in the prompt UI",
        },
        {
          flags: "--placeholder <placeholder>",
          description: "Placeholder text for the input",
        },
        {
          flags: "--usage-description <description>",
          description:
            "Human-readable description of intended usage, stored in credential metadata and shown as the prompt's purpose",
        },
        {
          flags: "--allowed-domains <domains>",
          description:
            "Comma-separated domains where this credential may be used",
        },
        {
          flags: "--allowed-tools <tools>",
          description:
            "Comma-separated tool names that may use this credential",
        },
        {
          flags: "--injection-templates <json>",
          description: "JSON array of injection template objects",
        },
      ],
      helpText: `
Opens a secure credential input prompt in the user's connected app (desktop,
web, etc.). The user enters the secret through the UI — it never passes through
the conversation or CLI output. On success the credential is stored in the
encrypted vault with the specified metadata.

Requires the assistant to be running with at least one connected client.

Examples:
  $ assistant credentials prompt --service sentry --field auth_token \\
      --label "Sentry Auth Token" --placeholder "sntrys_..." \\
      --usage-description "Read Sentry issues and events" \\
      --allowed-domains "sentry.io" \\
      --injection-templates '[{"hostPattern":"sentry.io","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]'`,
    },
  ],
};
