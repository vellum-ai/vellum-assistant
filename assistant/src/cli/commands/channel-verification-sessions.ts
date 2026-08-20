// `cli/no-daemon-internals` forbids hoisting `channels/types.js`, so the CLI
// reads the vocabulary straight from the contract package that file re-exports.
// Both sides then validate `--channel` against the same set.

import {
  CHANNEL_IDS,
  type ChannelId,
  isChannelId,
} from "@vellumai/service-contracts/channels";
import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { writeOutput } from "../output.js";
import { channelVerificationSessionsHelp } from "./channel-verification-sessions.help.js";

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
  registerCommand(program, {
    name: channelVerificationSessionsHelp.name,
    transport: "ipc",
    description: channelVerificationSessionsHelp.description,
    build: (cvs) => {
      applyCommandHelp(cvs, channelVerificationSessionsHelp);

      // ---------------------------------------------------------------------------
      // create
      // ---------------------------------------------------------------------------

      subcommand(cvs, "create").action(
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
          if (channel === false) {
            return;
          }

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
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }
          writeOutput(cmd, r.result);
        },
      );

      // ---------------------------------------------------------------------------
      // status
      // ---------------------------------------------------------------------------

      subcommand(cvs, "status").action(
        async (opts: { channel?: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd);
          if (channel === false) {
            return;
          }

          const r = await cliIpcCall("channel_verification_sessions_status", {
            body: { channel },
          });
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }
          writeOutput(cmd, r.result);
        },
      );

      // ---------------------------------------------------------------------------
      // resend
      // ---------------------------------------------------------------------------

      subcommand(cvs, "resend").action(
        async (
          opts: { channel: string; originConversationId?: string },
          cmd: Command,
        ) => {
          const channel = validateChannelOpt(opts.channel, cmd, true);
          if (channel === false) {
            return;
          }

          const r = await cliIpcCall("channel_verification_sessions_resend", {
            body: {
              channel,
              originConversationId: opts.originConversationId,
            },
          });
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }
          writeOutput(cmd, r.result);
        },
      );

      // ---------------------------------------------------------------------------
      // cancel
      // ---------------------------------------------------------------------------

      subcommand(cvs, "cancel").action(
        async (opts: { channel: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd, true);
          if (channel === false) {
            return;
          }

          const r = await cliIpcCall("channel_verification_sessions_cancel", {
            body: { channel },
          });
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }
          writeOutput(cmd, r.result);
        },
      );

      // ---------------------------------------------------------------------------
      // revoke
      // ---------------------------------------------------------------------------

      subcommand(cvs, "revoke").action(
        async (opts: { channel?: string }, cmd: Command) => {
          const channel = validateChannelOpt(opts.channel, cmd);
          if (channel === false) {
            return;
          }

          const r = await cliIpcCall("channel_verification_sessions_revoke", {
            body: { channel },
          });
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }
          writeOutput(cmd, r.result);
        },
      );
    },
  });
}
