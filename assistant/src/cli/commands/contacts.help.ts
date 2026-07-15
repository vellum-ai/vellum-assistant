/** Declarative help for the `assistant contacts` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const contactsHelp: CliCommandHelp = {
  name: "contacts",
  description: "Manage and query the contact graph",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
Contacts represent people and entities the assistant interacts with. Each
contact is identified by a UUID, has a role (contact or guardian), and
can be linked to external identifiers — phone numbers,
Telegram IDs, email addresses — via channel memberships. The contact graph
is the source of truth for identity resolution across all channels.

Examples:
  $ assistant contacts list
  $ assistant contacts get abc-123
  $ assistant contacts invites list`,
  subcommands: [
    {
      name: "list",
      description: "List contacts",
      options: [
        {
          flags: "--role <role>",
          description: "Filter by role (contact, guardian, or omit for all)",
        },
        {
          flags: "--limit <limit>",
          description: "Maximum number of contacts to return",
        },
        {
          flags: "--query <query>",
          description: "Search query to filter contacts",
        },
        {
          flags: "--channel-address <address>",
          description: "Search by channel address (email, phone, handle)",
        },
        {
          flags: "--channel-type <channelType>",
          description:
            "Filter by channel type (email, telegram, phone, whatsapp, slack)",
        },
      ],
      helpText: `
Lists contacts with optional filtering. The --role flag accepts: contact
or guardian (omit to show all). The --limit flag sets
the maximum number of results (defaults to 50).

When --query, --channel-address, or --channel-type is provided, a search
is performed. --query does full-text search across contact names and
linked external identifiers. --channel-address matches phone numbers,
emails, or handles. --channel-type filters by channel kind. These filters
can be combined. Without any search params, returns all contacts matching
the role filter.

Examples:
  $ assistant contacts list
  $ assistant contacts list --role guardian
  $ assistant contacts list --query "john" --limit 10
  $ assistant contacts list --channel-address "+15551234567"
  $ assistant contacts list --channel-type telegram
  $ assistant contacts list --query "alice" --channel-type email
  $ assistant contacts list --role guardian --json`,
    },
    {
      name: "get",
      args: "<id>",
      description: "Get a contact by ID",
      helpText: `
Arguments:
  id   UUID of the contact to retrieve. Run 'assistant contacts list' to find IDs.

Returns the full contact record including role, display name, and all
channel memberships (phone numbers, Telegram IDs, email addresses, etc.).
For assistant-type contacts, additional assistant metadata is included.

Examples:
  $ assistant contacts get 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant contacts get abc-123 --json`,
    },
    {
      name: "prompt",
      description: "Prompt user to register a contact channel via the app UI",
      options: [
        {
          flags: "--channel <channel>",
          description:
            "Suggested channel type hint (e.g. phone, email, telegram)",
        },
        {
          flags: "--placeholder <placeholder>",
          description: "Placeholder text for the address input field",
        },
        {
          flags: "--role <role>",
          description:
            "Intended role: guardian, trusted-contact, or unknown (default: unknown)",
        },
        {
          flags: "--label <label>",
          description: "Display label shown in the prompt UI",
        },
        {
          flags: "--description <description>",
          description: "Longer description shown in the prompt UI",
        },
        {
          flags: "--timeout <ms>",
          description:
            "How long to wait for the user to submit (ms). Defaults to match the server-side prompt timeout.",
          defaultValue: String(310_000),
        },
      ],
      helpText: `
Opens a contact address prompt in the user's app. The user enters a channel
address (phone number, email, Telegram ID, etc.). The address is saved with
status "unverified". Verification is a separate step.

Run \`assistant contacts prompt --help\` for full option details.`,
    },
    {
      name: "channels",
      description: "Manage contact channels",
      helpText: `
Channels represent external communication endpoints linked to contacts —
phone numbers, Telegram IDs, email addresses, etc. Each channel has a
status (active, pending, revoked, blocked, unverified) and a policy
(allow, deny) that controls how the assistant handles messages
from that channel.

Examples:
  $ assistant contacts channels update-status <channelId> --status revoked --reason "No longer needed"
  $ assistant contacts channels update-status <channelId> --policy deny`,
      subcommands: [
        {
          name: "update-status",
          args: "<channelId>",
          description: "Update a channel's status or policy",
          options: [
            {
              flags: "--status <status>",
              description: "New channel status: active, revoked, or blocked",
            },
            {
              flags: "--policy <policy>",
              description: "New channel policy: allow or deny",
            },
            {
              flags: "--reason <reason>",
              description: "Reason for the status change",
            },
          ],
          helpText: `
Arguments:
  channelId   UUID of the contact channel to update. Run 'assistant contacts get <contactId>'
              to see a contact's channel IDs.

Updates the access-control fields on an existing channel. At least one of
--status or --policy must be provided.

When --status is "revoked", --reason is mapped to revokedReason on the
channel record. When --status is "blocked", --reason is mapped to
blockedReason. The --reason flag is ignored for other status values.

Valid --status values: active, revoked, blocked
Valid --policy values: allow, deny

Examples:
  $ assistant contacts channels update-status abc-123 --status revoked --reason "No longer needed" --json
  $ assistant contacts channels update-status abc-123 --status blocked --reason "Spam" --json
  $ assistant contacts channels update-status abc-123 --policy deny --json
  $ assistant contacts channels update-status abc-123 --status active --policy allow --json`,
        },
      ],
    },
    {
      name: "invites",
      description: "Manage contact invites",
      helpText: `
Invites are tokens that grant channel access when redeemed. Each invite is
tied to a source channel (telegram, phone, email, whatsapp) and can
optionally have usage limits, expiration, and notes. When redeemed, the
invite creates a channel membership linking a contact to an external
identifier on the source channel.

Examples:
  $ assistant contacts invites list
  $ assistant contacts invites create --source-channel telegram
  $ assistant contacts invites revoke abc-123
  $ assistant contacts invites redeem --token xyz-789 --source-channel telegram --external-user-id 12345`,
      subcommands: [
        {
          name: "list",
          isDefault: true,
          description: "List invites",
          options: [
            {
              flags: "--source-channel <sourceChannel>",
              description: "Filter by source channel",
            },
            {
              flags: "--status <status>",
              description: "Filter by invite status",
            },
          ],
          helpText: `
Lists all invites with optional filtering by source channel or status.
Returns invite tokens, their source channels, usage counts, and expiration.

Examples:
  $ assistant contacts invites list
  $ assistant contacts invites list --source-channel telegram
  $ assistant contacts invites list --status active
  $ assistant contacts invites list --source-channel phone --json`,
        },
        {
          name: "create",
          description: "Create a new invite",
          options: [
            {
              flags: "--source-channel <channel>",
              description:
                "Source channel (e.g. telegram, phone, email, whatsapp)",
              required: true,
            },
            { flags: "--note <note>", description: "Optional note" },
            { flags: "--max-uses <n>", description: "Max redemptions" },
            {
              flags: "--expires-in-ms <ms>",
              description: "Expiry duration in milliseconds",
            },
            {
              flags: "--expected-external-user-id <id>",
              description: "E.164 phone number (required for voice invites)",
            },
            {
              flags: "--contact-id <id>",
              description: "Contact ID to bind the invite to",
              required: true,
            },
          ],
          helpText: `
Creates a new invite token for the specified source channel. The --source-channel
flag is required and must be one of: telegram, phone, email, whatsapp.

The invitee's display name is read from the bound contact (--contact-id);
the guardian label is resolved at runtime. There are no free-text name flags.

Optional fields:
  --note                        Free-text note attached to the invite
  --max-uses                    Maximum number of times the invite can be redeemed
  --expires-in-ms               Expiry duration in milliseconds from creation

Voice invites also require:
  --expected-external-user-id   E.164 phone number of the expected caller (e.g. +15551234567)

Examples:
  $ assistant contacts invites create --source-channel telegram --contact-id <id> --note "For Alice" --max-uses 1
  $ assistant contacts invites create --source-channel phone --contact-id <id> --expected-external-user-id "+15551234567"`,
        },
        {
          name: "revoke",
          args: "<inviteId>",
          description: "Revoke an active invite",
          helpText: `
Arguments:
  inviteId   UUID of the invite to revoke. Run 'assistant contacts invites list' to find IDs.

Revokes an active invite so it can no longer be redeemed. Already-redeemed
channel memberships are not affected. Returns the updated invite record.

Examples:
  $ assistant contacts invites revoke 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant contacts invites revoke abc-123 --json`,
        },
        {
          name: "redeem",
          description: "Redeem an invite via token or voice code",
          options: [
            { flags: "--token <token>", description: "Invite token" },
            {
              flags: "--source-channel <channel>",
              description: "Channel for redemption",
            },
            {
              flags: "--external-user-id <id>",
              description: "External user ID",
            },
            {
              flags: "--external-chat-id <id>",
              description: "External chat ID",
            },
            { flags: "--code <code>", description: "6-digit voice code" },
            {
              flags: "--caller-external-user-id <phone>",
              description: "E.164 phone number for voice code redemption",
            },
            {
              flags: "--assistant-id <id>",
              description: "Assistant ID for voice code redemption",
            },
          ],
          helpText: `
Two redemption modes:

1. Token-based redemption: Provide --token, --source-channel, and at
   least one of --external-user-id or --external-chat-id. Creates a
   channel membership linking the contact to the external identifier.

2. Voice-code-based redemption: Provide --code (6-digit code) and
   --caller-external-user-id (E.164 phone number). Optionally include
   --assistant-id to scope the redemption to a specific assistant.

Examples:
  $ assistant contacts invites redeem --token xyz-789 --source-channel telegram --external-user-id 12345
  $ assistant contacts invites redeem --code 123456 --caller-external-user-id "+15551234567"
  $ assistant contacts invites redeem --code 654321 --caller-external-user-id "+15559876543" --assistant-id asst-abc --json`,
        },
      ],
    },
  ],
};
