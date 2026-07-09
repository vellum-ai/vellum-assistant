/**
 * Static help structure for the `assistant attachment` command.
 *
 * Imports only `commander` so the memory capability indexer can read this
 * command's help without pulling in the daemon/IPC action graph. The action
 * handlers live in `attachment.ts`, which applies `configure` and then attaches
 * them.
 */

import type { Command } from "commander";

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const attachmentHelp: CliCommandHelp = {
  name: "attachment",
  description: "Manage file attachments for conversations",
  configure(attachment: Command): void {
    attachment.addHelpText(
      "after",
      `
Attachments come in two flavours:

  File-backed   Large files stored by path reference (no memory copy).
                The file must remain on disk for the lifetime of the
                attachment.
  Inline        Small payloads encoded directly (handled internally).

Use 'register' to record a file-backed attachment and 'lookup' to
retrieve its stored path by the original source location.

Examples:
  $ assistant attachment register --path /tmp/clip.mp4 --mime video/mp4
  $ assistant attachment register --path /tmp/clip.mp4 --mime video/mp4 --filename recording.mp4
  $ assistant attachment lookup --source /tmp/clip.mp4 --conversation conv_abc123`,
    );

    attachment
      .command("register")
      .description("Register a file-backed attachment with the assistant")
      .requiredOption("--path <file>", "Absolute path to the file (required)")
      .requiredOption("--mime <type>", "MIME type of the file (required)")
      .option(
        "--filename <name>",
        "Display filename (defaults to basename of path)",
      )
      .option("--json", "Output result as machine-readable JSON.")
      .addHelpText(
        "after",
        `
Registers a file on disk as a file-backed attachment in the assistant's
attachment store. The file must exist at the given path and must remain
on disk for the lifetime of the attachment — the assistant stores a
path reference, not a copy.

Returns the attachment ID and metadata on success.

Examples:
  $ assistant attachment register --path /tmp/clip.mp4 --mime video/mp4
  $ assistant attachment register --path /tmp/screen.png --mime image/png --filename screenshot.png
  $ assistant attachment register --path /tmp/audio.wav --mime audio/wav --json`,
      );

    attachment
      .command("lookup")
      .description("Look up a stored attachment by its original source path")
      .requiredOption(
        "--source <path>",
        "Original source path of the file (required)",
      )
      .requiredOption(
        "--conversation <id>",
        "Conversation ID to search within (required) — run 'assistant conversations list' to find it",
      )
      .option("--json", "Output result as machine-readable JSON.")
      .addHelpText(
        "after",
        `
Searches for an attachment that was previously registered with the
given source path, scoped to a specific conversation. Returns the
stored file path on success.

Attachments are linked to messages within conversations. Use
'assistant conversations list' to find the conversation ID.

Examples:
  $ assistant attachment lookup --source /tmp/clip.mp4 --conversation conv_abc123
  $ assistant attachment lookup --source /path/to/recording.mp4 --conversation conv_xyz --json`,
      );
  },
};
