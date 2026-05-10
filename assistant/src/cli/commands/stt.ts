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
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

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
    name: "stt",
    transport: "ipc",
    description: "Speech-to-text operations",
    build: (sttCmd) => {
      sttCmd.addHelpText(
        "after",
        `
Speech-to-text commands use your configured STT provider to transcribe
audio and video files. The provider is set via:

  $ assistant config set services.stt.provider <provider>

Supported providers: openai-whisper, deepgram, google-gemini, xai.

Examples:
  $ assistant stt transcribe --file /path/to/meeting.wav
  $ assistant stt transcribe --file /path/to/video.mp4 --json`,
      );

      // ── transcribe ──────────────────────────────────────────────────────

      sttCmd
        .command("transcribe")
        .description("Transcribe an audio or video file to text")
        .requiredOption(
          "--file <path>",
          "Absolute path to the audio/video file",
        )
        .option(
          "--json",
          "Output structured JSON instead of plain transcript text",
        )
        .addHelpText(
          "after",
          `
Transcribes an audio or video file using the configured speech-to-text
provider. Video files automatically have their audio extracted via ffmpeg.
Large files (>25MB as WAV) are automatically split into chunks and
transcribed sequentially.

Supported audio formats: .mp3, .wav, .m4a, .aac, .ogg, .flac, .aiff, .wma
Supported video formats: .mp4, .mov, .avi, .mkv, .webm, .m4v, .mpeg, .mpg

Requires ffmpeg and ffprobe to be installed and on PATH.

Examples:
  $ assistant stt transcribe --file /path/to/recording.wav
  $ assistant stt transcribe --file /path/to/meeting.mp4
  $ assistant stt transcribe --file /path/to/podcast.mp3 --json`,
        )
        .action(async (opts: { file: string; json?: boolean }) => {
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
        });
    },
  });
}
