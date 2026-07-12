/**
 * `assistant attachment` CLI namespace.
 *
 * Subcommands: register, lookup — thin wrappers over the daemon's
 * attachment routes (`attachment_register`, `attachment_lookup`).
 *
 * The command's help structure lives in `attachment.help.ts` (import-safe for
 * the memory capability indexer); this module applies it and attaches the
 * action handlers.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { attachmentHelp } from "./attachment.help.js";

// ── Registration ──────────────────────────────────────────────────────

export function registerAttachmentCommand(program: Command): void {
  registerCommand(program, {
    name: attachmentHelp.name,
    transport: "ipc",
    description: attachmentHelp.description,
    build: (attachment) => {
      applyCommandHelp(attachment, attachmentHelp);

      // ── register ───────────────────────────────────────────────────
      subcommand(attachment, "register").action(
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

      // ── lookup ─────────────────────────────────────────────────────
      subcommand(attachment, "lookup").action(
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
    },
  });
}
