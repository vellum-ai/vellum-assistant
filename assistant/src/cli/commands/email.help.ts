/** Declarative help for the `assistant email` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const emailHelp: CliCommandHelp = {
  name: "email",
  description:
    "Get your own email address — register, send, receive, and manage email natively",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
Set up and manage this assistant's native email address on the Vellum
platform. No third-party email provider or browser sign-up needed.

Examples:
  $ assistant email register mybot
  $ assistant email unregister --confirm
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  $ assistant email status
  $ assistant email list
  $ assistant email attachment msg_abc1 --list
  $ assistant email attachment msg_abc1 att_xyz1
  $ assistant email register mybot --json`,
  subcommands: [
    {
      name: "register",
      args: "<username>",
      description: "Register an email address for this assistant",
    },
    {
      name: "unregister",
      description: "Remove the email address registered for this assistant",
      options: [
        { flags: "--confirm", description: "Skip confirmation prompt" },
      ],
    },
    {
      name: "status",
      description: "Show email address info and usage for this assistant",
    },
    {
      name: "list",
      description: "List received and sent emails for this assistant",
      options: [
        {
          flags: "-d, --direction <direction>",
          description: "Filter by direction: inbound, outbound, or all",
          defaultValue: "all",
        },
        {
          flags: "-l, --limit <count>",
          description: "Maximum number of results",
          defaultValue: "20",
        },
        {
          flags: "--since <date>",
          description: "Only show messages since this date (ISO 8601)",
        },
      ],
      helpText: `
Lists email messages for this assistant. Shows subject, from, to,
direction, and timestamp for each message.

Examples:
  $ assistant email list
  $ assistant email list --direction inbound --limit 5
  $ assistant email list --since 2026-04-01 --json`,
    },
    {
      name: "download",
      args: "<message-id>",
      description: "Download a specific email message",
      options: [
        {
          flags: "--format <type>",
          description: "Output format: text, html, json (default: text)",
          defaultValue: "text",
        },
        {
          flags: "-o, --output <path>",
          description: "Write to file instead of stdout",
        },
      ],
    },
    {
      name: "send",
      args: "<to...>",
      description: "Send an email from this assistant",
      options: [
        { flags: "-s, --subject <text>", description: "Subject line" },
        { flags: "-b, --body <text>", description: "Email body (plain text)" },
        { flags: "-f, --file <path>", description: "Read body from file" },
        { flags: "--html <path>", description: "HTML body file (optional)" },
        { flags: "--cc <address>", description: "CC recipient (repeatable)" },
        { flags: "--bcc <address>", description: "BCC recipient (repeatable)" },
        {
          flags: "--reply-to <email_id>",
          description:
            "Reply to an email by its ID (auto-resolves threading headers and subject)",
        },
      ],
      helpText: `
Arguments:
  to   Recipient email address(es) — one or more

Sends an email from the assistant's registered email address via the
Vellum runtime proxy. The "from" address is automatically resolved
from the assistant's registered email address.

Body source priority: --body flag > --file flag > stdin (if not a TTY).

When --reply-to is provided, the platform auto-resolves In-Reply-To,
References, and Subject headers from the referenced email. You can
still override subject with -s.

Examples:
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  ✓ Sent to user@example.com (delivery_id: abc123)

  $ assistant email send a@example.com b@example.com --cc c@example.com -s "Team" -b "Hi all"
  ✓ Sent to a@example.com, b@example.com (delivery_id: abc123)

  $ assistant email send user@example.com --bcc boss@example.com -s "FYI" -b "See below"
  ✓ Sent to user@example.com (delivery_id: def456)

  $ assistant email send user@example.com -b "Thanks!" --reply-to 019d96e4-e5d2-7201-890e-04a21e8f95bb
  ✓ Sent to user@example.com (delivery_id: ghi789)

  $ assistant email send user@example.com -s "Hello" -b "Hi" --json
  {"delivery_id":"abc123","status":"accepted"}`,
    },
    {
      name: "attachment",
      args: "<message-id> [attachment-id]",
      description: "Download email attachments",
      options: [
        {
          flags: "--all",
          description: "Download all attachments for the message",
        },
        {
          flags: "-o, --output <dir>",
          description: "Output directory (default: current directory)",
          defaultValue: ".",
        },
        {
          flags: "--list",
          description: "List attachments without downloading",
        },
      ],
      helpText: `
Arguments:
message-id      Email message ID (from \`assistant email list --json\`)
attachment-id   Attachment ID (optional — required unless --all or --list)

Download one or all attachments from a specific email message. Use
--list to see available attachments without downloading.

Examples:
$ assistant email attachment msg_abc1 --list
$ assistant email attachment msg_abc1 att_xyz1
$ assistant email attachment msg_abc1 att_xyz1 -o ./downloads/
$ assistant email attachment msg_abc1 --all
$ assistant email attachment msg_abc1 --all -o ./attachments/
$ assistant email attachment msg_abc1 --list --json`,
    },
  ],
};
