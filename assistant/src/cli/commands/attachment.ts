/**
 * `assistant attachment` CLI namespace.
 *
 * Subcommands: register, lookup — thin wrappers over the daemon's
 * attachment routes (`attachment_register`, `attachment_lookup`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ── Registration ──────────────────────────────────────────────────────

export function registerAttachmentCommand(program: Command): void {
  const attachment = program
    .command("attachment")
    .description("Manage file attachments for conversations");

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

  // ── register ─────────────────────────────────────────────────────

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
    )
    .action(
      async (
        opts: {
          path: string;
          mime: string;
          filename?: string;
          json?: boolean;
        },
        cmd: Command,
      ) => {
        const jsonOutput = opts.json || shouldOutputJson(cmd);

        const result = await cliIpcCall<{
          id: string;
          originalFilename: string;
          mimeType: string;
          sizeBytes: number;
          kind: string;
          filePath: string;
          createdAt: number;
        }>("attachment_register", {
          body: {
            path: opts.path,
            mimeType: opts.mime,
            filename: opts.filename,
          },
        });

        if (!result.ok) {
          if (jsonOutput) {
            writeOutput(cmd, { ok: false, error: result.error });
          } else {
            log.error(result.error ?? "Unknown error");
          }
          process.exitCode = 1;
          return;
        }

        const record = result.result!;

        if (jsonOutput) {
          writeOutput(cmd, { ok: true, ...record });
        } else {
          process.stdout.write(`${record.id}\n`);
          log.info(`Attachment registered: ${record.id}`);
          log.info(`  Filename: ${record.originalFilename}`);
          log.info(`  MIME:     ${record.mimeType}`);
          log.info(`  Size:     ${record.sizeBytes} bytes`);
          log.info(`  Kind:     ${record.kind}`);
          log.info(`  Path:     ${record.filePath}`);
        }
      },
    );

  // ── lookup ───────────────────────────────────────────────────────

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
    )
    .action(
      async (
        opts: { source: string; conversation: string; json?: boolean },
        cmd: Command,
      ) => {
        const jsonOutput = opts.json || shouldOutputJson(cmd);

        const result = await cliIpcCall<{ filePath: string }>(
          "attachment_lookup",
          {
            body: {
              sourcePath: opts.source,
              conversationId: opts.conversation,
            },
          },
        );

        if (!result.ok) {
          if (jsonOutput) {
            writeOutput(cmd, { ok: false, error: result.error });
          } else {
            log.error(result.error ?? "Unknown error");
          }
          process.exitCode = 1;
          return;
        }

        if (jsonOutput) {
          writeOutput(cmd, {
            ok: true,
            filePath: result.result!.filePath,
          });
        } else {
          process.stdout.write(result.result!.filePath + "\n");
        }
      },
    );
}
