/**
 * CLI command group: `assistant stt`
 *
 * Speech-to-text operations using the configured STT provider.
 * Thin IPC wrapper — all daemon work (ffmpeg conversion, chunking,
 * transcription) is handled by the stt_transcribe_file route.
 */

import { extname, resolve } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { sttHelp } from "./stt.help.js";

// ---------------------------------------------------------------------------
// Constants (client-side extension validation only)
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mpeg",
  ".mpg",
]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".aiff",
  ".wma",
]);

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSttCommand(program: Command): void {
  registerCommand(program, {
    name: sttHelp.name,
    transport: "ipc",
    description: sttHelp.description,
    build: (sttCmd) => {
      applyCommandHelp(sttCmd, sttHelp);

      // ── transcribe ──────────────────────────────────────────────────────

      subcommand(sttCmd, "transcribe").action(
        async (opts: { file: string; json?: boolean }) => {
          const filePath = resolve(opts.file);
          const jsonOutput = opts.json ?? false;

          // Client-side extension validation (provides clear error before hitting daemon)
          const ext = extname(filePath).toLowerCase();
          const isVideo = VIDEO_EXTENSIONS.has(ext);
          const isAudio = AUDIO_EXTENSIONS.has(ext);
          if (!isVideo && !isAudio) {
            const msg = `Unsupported file type: ${ext}. Only audio and video files can be transcribed.`;
            if (jsonOutput) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{
            transcript: string;
            provider: string;
            durationSeconds: number;
          }>("stt_transcribe_file", { body: { filePath } });

          if (!r.ok) {
            if (jsonOutput) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: r.error }) + "\n",
              );
              process.exitCode = 1;
              return;
            }
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
            );
          }

          const { transcript, provider, durationSeconds } = r.result!;

          if (!transcript.trim()) {
            if (jsonOutput) {
              process.stdout.write(
                JSON.stringify({
                  ok: true,
                  transcript: "",
                  provider,
                  durationSeconds,
                }) + "\n",
              );
            } else {
              process.stdout.write("No speech detected in the audio.\n");
            }
            return;
          }

          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({
                ok: true,
                transcript,
                provider,
                durationSeconds,
              }) + "\n",
            );
          } else {
            process.stdout.write(transcript + "\n");
          }
        },
      );
    },
  });
}
