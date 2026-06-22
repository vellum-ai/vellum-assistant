import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Local channel validation (replaces daemon-internal channels/types.js import)
// ---------------------------------------------------------------------------

const VALID_CHANNEL_IDS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
] as const;
type ChannelId = (typeof VALID_CHANNEL_IDS)[number];

function isChannelId(raw: string): raw is ChannelId {
  return (VALID_CHANNEL_IDS as readonly string[]).includes(raw);
}

/**
 * Validate the --channel option. Returns the validated ChannelId or writes an
 * error and returns `false`. When `required` is false an absent value is fine
 * (returns `undefined`).
 */
function validateChannelOpt(
  raw: string | undefined,
  cmd: Command,
  required: true,
): ChannelId | false;
function validateChannelOpt(
  raw: string | undefined,
  cmd: Command,
  required?: false,
): ChannelId | undefined | false;
function validateChannelOpt(
  raw: string | undefined,
  cmd: Command,
  required?: boolean,
): ChannelId | undefined | false {
  if (raw === undefined) {
    if (required) {
      writeOutput(cmd, {
        ok: false,
        error: `The "channel" option is required. Valid values: ${VALID_CHANNEL_IDS.join(", ")}`,
      });
      process.exitCode = 1;
      return false;
    }
    return undefined;
  }
  if (!isChannelId(raw)) {
    writeOutput(cmd, {
      ok: false,
      error: `Invalid channel "${raw}". Valid values: ${VALID_CHANNEL_IDS.join(", ")}`,
    });
    process.exitCode = 1;
    return false;
  }
  return raw;
}

export function registerChannelVerificationSessionsCommand(
  program: Command,
): void {
  registerCommand(program, {
    name: "channel-verification-sessions",
    transport: "ipc",
    description: "Manage channel verification sessions",
    build: (cvs) => {
      cvs.option("--json", "Machine-readable compact JSON output");

      cvs.addHelpText(
        "after",
        `
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
      );

      // ---------------------------------------------------------------------------
      // create
      // ---------------------------------------------------------------------------

      cvs
        .command("create")
        .description("Create a new verification session")
        .option("--channel <channel>", "Channel type (telegram, phone, slack, email)")
        .option(
          "--destination <destination>",
          "Destination address for outbound verification (handle, phone number, user ID, or email address)",
        )
        .option("--rebind", "Replace existing guardian binding")
        .option(
          "--conversation-id <conversationId>",
          "Conversation ID for inbound challenges",
        )
        .option(
          "--origin-conversation-id <id>",
          "Origin conversation ID for routing",
        )
        .option(
          "--purpose <purpose>",
          'Verification purpose: "guardian" (default) or "trusted_contact"',
        )
        .option(
          "--contact-channel-id <id>",
          "Contact channel ID (required when purpose is trusted_contact)",
        )
        .addHelpText(
          "after",
          `
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
        )
        .action(
          async (
            opts: {
              channel?: string;
              destination?: string;
              rebind?: boolean;
              conversationId?: string;
              originConversationId?: string;
              purpose?: string;
              contactChannelId?: string;
            },
            cmd: Command,
          ) => {
            const channel = validateChannelOpt(opts.channel, cmd);
            if (channel === false) return;

            const r = await cliIpcCall("channel_verification_sessions_create", {
              body: {
                channel,
                destination: opts.destination,
                rebind: opts.rebind,
                conversationId: opts.conversationId,
                originConversationId: opts.originConversationId,
                purpose: opts.purpose ?? "guardian",
                contactChannelId: opts.contactChannelId,
              },
            });
            if (!r.ok)
              return exitFromIpcResult(
                r as { ok: false; error?: string; statusCode?: number },
                cmd,
              );
            writeOutput(cmd, r.result);
          },
        );

      // ---------------------------------------------------------------------------
      // status
      // ---------------------------------------------------------------------------

      cvs
        .command("status")
        .description("Get verification status for a channel")
        .option(
          "--channel <channel>",
          "Channel type (telegram, phone). Defaults to telegram.",
        )
        .addHelpText(
          "after",
          `
Returns the current verification state for a channel, including whether a
guardian is bound, pending challenge status, and any active outbound session
details (session ID, expiry, send count).

Defaults to telegram if --channel is omitted.

Examples:
  $ assistant channel-verification-sessions status
  $ assistant channel-verification-sessions status --channel phone
  $ assistant channel-verification-sessions status --channel telegram --json`,
        )
        .action(async (opts: { channel?: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd);
          if (channel === false) return;

          const r = await cliIpcCall("channel_verification_sessions_status", {
            body: { channel },
          });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          writeOutput(cmd, r.result);
        });

      // ---------------------------------------------------------------------------
      // resend
      // ---------------------------------------------------------------------------

      cvs
        .command("resend")
        .description(
          "Resend the verification code for an active outbound session",
        )
        .requiredOption(
          "--channel <channel>",
          "Channel type (telegram, phone, slack, email)",
        )
        .option(
          "--origin-conversation-id <id>",
          "Origin conversation ID for routing",
        )
        .addHelpText(
          "after",
          `
Resends the verification code for the active outbound session on the
specified channel. Subject to per-session and per-destination rate limits.

The --channel flag is required and must match the channel of the active session.

Examples:
  $ assistant channel-verification-sessions resend --channel telegram
  $ assistant channel-verification-sessions resend --channel phone --origin-conversation-id conv-123`,
        )
        .action(
          async (
            opts: { channel: string; originConversationId?: string },
            cmd: Command,
          ) => {
            const channel = validateChannelOpt(opts.channel, cmd, true);
            if (channel === false) return;

            const r = await cliIpcCall("channel_verification_sessions_resend", {
              body: {
                channel,
                originConversationId: opts.originConversationId,
              },
            });
            if (!r.ok)
              return exitFromIpcResult(
                r as { ok: false; error?: string; statusCode?: number },
                cmd,
              );
            writeOutput(cmd, r.result);
          },
        );

      // ---------------------------------------------------------------------------
      // cancel
      // ---------------------------------------------------------------------------

      cvs
        .command("cancel")
        .description("Cancel all active verification sessions for a channel")
        .requiredOption(
          "--channel <channel>",
          "Channel type (telegram, phone, slack, email)",
        )
        .addHelpText(
          "after",
          `
Cancels both active outbound sessions and pending inbound challenges for
the specified channel. Does not revoke an existing guardian binding — use
the "revoke" subcommand for that.

The --channel flag is required.

Examples:
  $ assistant channel-verification-sessions cancel --channel telegram
  $ assistant channel-verification-sessions cancel --channel phone --json`,
        )
        .action(async (opts: { channel: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd, true);
          if (channel === false) return;

          const r = await cliIpcCall("channel_verification_sessions_cancel", {
            body: { channel },
          });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          writeOutput(cmd, r.result);
        });

      // ---------------------------------------------------------------------------
      // revoke
      // ---------------------------------------------------------------------------

      cvs
        .command("revoke")
        .description(
          "Revoke the guardian binding and cancel all sessions for a channel",
        )
        .option(
          "--channel <channel>",
          "Channel type. Defaults to telegram if omitted.",
        )
        .addHelpText(
          "after",
          `
Performs a complete teardown: cancels any active outbound sessions, revokes
pending inbound challenges, and revokes the guardian binding itself. The
guardian's contact channel is also revoked.

Defaults to telegram if --channel is omitted, matching the API behavior.

Examples:
  $ assistant channel-verification-sessions revoke
  $ assistant channel-verification-sessions revoke --channel phone
  $ assistant channel-verification-sessions revoke --channel telegram --json`,
        )
        .action(async (opts: { channel?: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd);
          if (channel === false) return;

          const r = await cliIpcCall("channel_verification_sessions_revoke", {
            body: { channel },
          });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          writeOutput(cmd, r.result);
        });
    },
  });
}
