import type { Command } from "commander";

import { CHANNEL_IDS, type ChannelId, isChannelId } from "../../channels/types.js";
import {
  createInboundChallenge,
  getVerificationStatus,
  revokeVerificationForChannel,
  verifyTrustedContact,
} from "../../daemon/handlers/config-channels.js";
import { initializeDb } from "../../memory/db.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { revokePendingSessions } from "../../runtime/channel-verification-service.js";
import {
  cancelOutbound,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../../runtime/verification-outbound-actions.js";
import { verificationRateLimiter } from "../../runtime/verification-rate-limiter.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import { writeOutput } from "../utils.js";

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
        error: `The "channel" option is required. Valid values: ${CHANNEL_IDS.join(", ")}`,
      });
      process.exitCode = 1;
      return false;
    }
    return undefined;
  }
  if (!isChannelId(raw)) {
    writeOutput(cmd, {
      ok: false,
      error: `Invalid channel "${raw}". Valid values: ${CHANNEL_IDS.join(", ")}`,
    });
    process.exitCode = 1;
    return false;
  }
  return raw;
}

export function registerChannelVerificationSessionsCommand(
  program: Command,
): void {
  const cvs = program
    .command("channel-verification-sessions")
    .description("Manage channel verification sessions")
    .option("--json", "Machine-readable compact JSON output");

  cvs.addHelpText(
    "after",
    `
Verification sessions are used to verify guardian bindings and trusted
contacts across channels (telegram, phone, slack). Three flows exist:

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
    .option("--channel <channel>", "Channel type (telegram, phone, slack)")
    .option(
      "--destination <destination>",
      "Destination address for outbound verification (handle, phone number, or user ID)",
    )
    .option("--rebind", "Replace existing guardian binding")
    .option("--session-id <sessionId>", "Session ID for inbound challenges")
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
     (handle or chat ID), phone (E.164 number), and slack (user ID).
     Use --rebind to replace an existing guardian binding.

  3. Inbound: --channel <ch> (no --destination)
     Generates a challenge secret for the guardian to send back on the
     channel. Defaults to telegram if --channel is omitted.

Examples:
  $ assistant channel-verification-sessions create --purpose trusted_contact --contact-channel-id abc-123
  $ assistant channel-verification-sessions create --channel telegram --destination "@guardian_handle"
  $ assistant channel-verification-sessions create --channel phone --destination "+15551234567" --rebind
  $ assistant channel-verification-sessions create --channel telegram --session-id sess-123`,
    )
    .action(
      async (
        opts: {
          channel?: string;
          destination?: string;
          rebind?: boolean;
          sessionId?: string;
          originConversationId?: string;
          purpose?: string;
          contactChannelId?: string;
        },
        cmd: Command,
      ) => {
        try {
          initializeDb();

          const purpose = opts.purpose ?? "guardian";
          const channel = validateChannelOpt(opts.channel, cmd);
          if (channel === false) return;

          // --- Trusted contact path ---
          if (purpose === "trusted_contact") {
            if (!opts.contactChannelId) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "contactChannelId is required for trusted_contact purpose",
              });
              process.exitCode = 1;
              return;
            }
            const result = await verifyTrustedContact(
              opts.contactChannelId,
              DAEMON_INTERNAL_ASSISTANT_ID,
            );
            writeOutput(cmd, result);
            if (!result.success) {
              process.exitCode = 1;
            }
            return;
          }

          // --- Outbound path ---
          if (opts.destination) {
            if (!channel) {
              writeOutput(cmd, {
                ok: false,
                error:
                  'The "channel" option is required for outbound verification.',
              });
              process.exitCode = 1;
              return;
            }

            // Normalize destination for rate limiting
            let rateLimitKey: string | undefined = opts.destination;
            if (rateLimitKey) {
              if (channel === "phone") {
                rateLimitKey =
                  normalizePhoneNumber(rateLimitKey) ?? rateLimitKey;
              } else if (channel === "telegram") {
                rateLimitKey = normalizeTelegramDestination(rateLimitKey);
              }
            }

            if (
              rateLimitKey &&
              verificationRateLimiter.isBlocked(rateLimitKey)
            ) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "Too many verification attempts for this identity. Please try again later.",
              });
              process.exitCode = 1;
              return;
            }

            const result = await startOutbound({
              channel,
              destination: opts.destination,
              rebind: opts.rebind,
              originConversationId: opts.originConversationId,
            });

            if (!result.success && rateLimitKey) {
              verificationRateLimiter.recordFailure(rateLimitKey);
            }

            writeOutput(cmd, result);
            if (!result.success) {
              process.exitCode = 1;
            }
            return;
          }

          // --- Inbound challenge path ---
          const result = createInboundChallenge(
            channel,
            opts.rebind,
            opts.sessionId,
          );
          writeOutput(cmd, result);
          if (!result.success) {
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
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
      try {
        initializeDb();
        const channel = validateChannelOpt(opts.channel, cmd);
        if (channel === false) return;
        const result = getVerificationStatus(channel);
        writeOutput(cmd, result);
        if (!result.success) {
          process.exitCode = 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // resend
  // ---------------------------------------------------------------------------

  cvs
    .command("resend")
    .description("Resend the verification code for an active outbound session")
    .requiredOption(
      "--channel <channel>",
      "Channel type (telegram, phone, slack)",
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
        try {
          initializeDb();
          const channel = validateChannelOpt(opts.channel, cmd, true);
          if (channel === false) return;
          const result = resendOutbound({
            channel,
            originConversationId: opts.originConversationId,
          });
          writeOutput(cmd, result);
          if (!result.success) {
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
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
      "Channel type (telegram, phone, slack)",
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
      try {
        initializeDb();
        const channel = validateChannelOpt(opts.channel, cmd, true);
        if (channel === false) return;
        cancelOutbound({ channel });
        revokePendingSessions(channel);
        writeOutput(cmd, { success: true, channel });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
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
      try {
        initializeDb();
        const channel = validateChannelOpt(opts.channel, cmd);
        if (channel === false) return;
        const result = revokeVerificationForChannel(channel);
        writeOutput(cmd, result);
        if (!result.success) {
          process.exitCode = 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
