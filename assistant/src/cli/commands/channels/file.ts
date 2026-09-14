/**
 * `assistant channels file`: fetch a file the channel's bot can see, by the
 * channel's own file id.
 *
 * The file door. It runs the daemon function behind
 * `GET /v1/channels/:channel/files/:fileId` in-process, as `oauth request`
 * does, so a large file never crosses IPC. The channel's transport resolves
 * the file's URL and the bot credential itself, so the caller names an id
 * and never a URL, and the credential reaches the platform's file host only
 * from code the adapter owns. The raw request door keeps its allowlist at
 * the API host for the same reason.
 *
 * A channel whose transport cannot fetch a file by id is refused before
 * anything is requested.
 */

import { writeFileSync } from "node:fs";

import type { Command } from "commander";

import { exitCodeFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeError, writeOutput } from "../../output.js";

interface ChannelFileOptions {
  output?: string;
  account?: string;
}

export function registerChannelsFileCommand(channels: Command): void {
  subcommand(channels, "file")
    .option("-o, --output <file>", "Write the file's bytes to this path")
    .option(
      "--account <account>",
      "The bot account to fetch as, for a channel connected to several",
    )
    .action(
      async (
        channel: string,
        fileId: string,
        opts: ChannelFileOptions,
        cmd: Command,
      ) => {
        const { handleChannelFile } =
          await import("../../../runtime/routes/channel-file-routes.js");
        const { RouteError } =
          await import("../../../runtime/routes/errors.js");

        let result: {
          channel: string;
          fileId: string;
          filename: string;
          mimeType: string;
          size: number;
          body: string;
          bodyEncoding: "base64";
        };
        try {
          result = (await handleChannelFile({
            pathParams: { channel, fileId },
            queryParams: opts.account ? { account: opts.account } : {},
          })) as typeof result;
        } catch (err) {
          if (err instanceof RouteError) {
            writeError(
              cmd,
              `${err.message}\n\nFor channel diagnostics, run 'assistant channels get ${channel}'.`,
            );
            process.exitCode = exitCodeFromIpcResult({
              statusCode: err.statusCode,
            });
            return;
          }
          throw err;
        }

        const bytes = Buffer.from(result.body, "base64");
        if (opts.output) {
          writeFileSync(opts.output, bytes);
        }

        if (shouldOutputJson(cmd)) {
          // The envelope without the bytes: a file's contents belong in the
          // file, and a JSON reader wants what it is, not what is in it.
          const { body: _body, bodyEncoding: _encoding, ...envelope } = result;
          writeOutput(cmd, {
            ...envelope,
            ...(opts.output ? { output: opts.output } : {}),
          });
          return;
        }

        if (opts.output) {
          process.stderr.write(
            `Wrote ${result.size} bytes (${result.mimeType}) to ${opts.output}\n`,
          );
          return;
        }
        process.stdout.write(bytes);
      },
    );
}
