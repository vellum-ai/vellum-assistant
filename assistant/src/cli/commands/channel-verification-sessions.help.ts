/** Declarative help for the `assistant channel-verification-sessions` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const channelVerificationSessionsHelp: CliCommandHelp = {
  name: "channel-verification-sessions",
  description: "Manage channel verification sessions",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
Verification sessions are used to verify guardian bindings and trusted
contacts across channels (telegram, phone, slack, email). Three flows exist:

  1. Inbound challenge — the assistant generates a secret code and waits
     for the guardian to send it back on the channel. Used when the
     guardian can already message the assistant.

  2. Outbound verification — the assistant sends a verification code to
     a destination (Telegram handle, phone number, Slack user ID) and
     waits for confirmation. Used when bootstrapping a new channel.

  3. Trusted contact verification — verifies a contact channel that
     already exists in the contact graph, sending a code to the channel
     address on file.

Examples:
  $ assistant channel-verification-sessions create --channel telegram
  $ assistant channel-verification-sessions create --channel phone --destination "+15551234567"
  $ assistant channel-verification-sessions create --purpose trusted_contact --contact-channel-id abc-123
  $ assistant channel-verification-sessions status --channel telegram`,
  subcommands: [
    {
      name: "create",
      description: "Create a new verification session",
      options: [
        {
          flags: "--channel <channel>",
          description: "Channel type (telegram, phone, slack, email)",
        },
        {
          flags: "--destination <destination>",
          description:
            "Destination address for outbound verification (handle, phone number, user ID, or email address)",
        },
        { flags: "--rebind", description: "Replace existing guardian binding" },
        {
          flags: "--conversation-id <conversationId>",
          description: "Conversation ID for inbound challenges",
        },
        {
          flags: "--origin-conversation-id <id>",
          description: "Origin conversation ID for routing",
        },
        {
          flags: "--purpose <purpose>",
          description:
            'Verification purpose: "guardian" (default) or "trusted_contact"',
        },
        {
          flags: "--contact-channel-id <id>",
          description:
            "Contact channel ID (required when purpose is trusted_contact)",
        },
      ],
      helpText: `
Routes between three creation modes based on the provided options:

  1. Trusted contact: --purpose trusted_contact --contact-channel-id <id>
     Verifies an existing contact channel. Sends a verification code to
     the channel address on file.

  2. Outbound: --channel <ch> --destination <dest>
     Sends a verification code to the given destination. Supports telegram
     (handle or chat ID), phone (E.164 number), slack (user ID), and email.
     Use --rebind to replace an existing guardian binding.

  3. Inbound: --channel <ch> (no --destination)
     Generates a challenge secret for the guardian to send back on the
     channel. Defaults to telegram if --channel is omitted.

Examples:
  $ assistant channel-verification-sessions create --purpose trusted_contact --contact-channel-id abc-123
  $ assistant channel-verification-sessions create --channel telegram --destination "@guardian_handle"
  $ assistant channel-verification-sessions create --channel phone --destination "+15551234567" --rebind
  $ assistant channel-verification-sessions create --channel telegram --conversation-id conv-123`,
    },
    {
      name: "status",
      description: "Get verification status for a channel",
      options: [
        {
          flags: "--channel <channel>",
          description: "Channel type (telegram, phone). Defaults to telegram.",
        },
      ],
      helpText: `
Returns the current verification state for a channel, including whether a
guardian is bound, pending challenge status, and any active outbound session
details (session ID, expiry, send count).

Defaults to telegram if --channel is omitted.

Examples:
  $ assistant channel-verification-sessions status
  $ assistant channel-verification-sessions status --channel phone
  $ assistant channel-verification-sessions status --channel telegram --json`,
    },
    {
      name: "resend",
      description:
        "Resend the verification code for an active outbound session",
      options: [
        {
          flags: "--channel <channel>",
          description: "Channel type (telegram, phone, slack, email)",
          required: true,
        },
        {
          flags: "--origin-conversation-id <id>",
          description: "Origin conversation ID for routing",
        },
      ],
      helpText: `
Resends the verification code for the active outbound session on the
specified channel. Subject to per-session and per-destination rate limits.

The --channel flag is required and must match the channel of the active session.

Examples:
  $ assistant channel-verification-sessions resend --channel telegram
  $ assistant channel-verification-sessions resend --channel phone --origin-conversation-id conv-123`,
    },
    {
      name: "cancel",
      description: "Cancel all active verification sessions for a channel",
      options: [
        {
          flags: "--channel <channel>",
          description: "Channel type (telegram, phone, slack, email)",
          required: true,
        },
      ],
      helpText: `
Cancels both active outbound sessions and pending inbound challenges for
the specified channel. Does not revoke an existing guardian binding — use
the "revoke" subcommand for that.

The --channel flag is required.

Examples:
  $ assistant channel-verification-sessions cancel --channel telegram
  $ assistant channel-verification-sessions cancel --channel phone --json`,
    },
    {
      name: "revoke",
      description:
        "Revoke the guardian binding and cancel all sessions for a channel",
      options: [
        {
          flags: "--channel <channel>",
          description: "Channel type. Defaults to telegram if omitted.",
        },
      ],
      helpText: `
Performs a complete teardown: cancels any active outbound sessions, revokes
pending inbound challenges, and revokes the guardian binding itself. The
guardian's contact channel is also revoked.

Defaults to telegram if --channel is omitted, matching the API behavior.

Examples:
  $ assistant channel-verification-sessions revoke
  $ assistant channel-verification-sessions revoke --channel phone
  $ assistant channel-verification-sessions revoke --channel telegram --json`,
    },
  ],
};
