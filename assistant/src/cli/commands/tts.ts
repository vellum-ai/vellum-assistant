/**
 * CLI command group: `assistant tts`
 *
 * Text-to-speech operations using the configured TTS provider.
 * Thin IPC wrapper — delegates synthesis to the daemon over the IPC socket.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_USE_CASES = ["message-playback", "phone-call"] as const;
type TtsUseCaseCli = (typeof VALID_USE_CASES)[number];

// ---------------------------------------------------------------------------
// MIME type → file extension mapping (presentation-layer concern)
// ---------------------------------------------------------------------------

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/opus":
      return "opus";
    // Raw PCM — ElevenLabs `pcm_{16000,22050,24000,44100}`, Deepgram
    // `linear16`, xAI `pcm`. No universal container format; `.pcm` is the
    // conventional extension for headerless linear-PCM samples.
    case "audio/pcm":
      return "pcm";
    // µ-law telephony audio — ElevenLabs `ulaw_8000`. `.ulaw` is the
    // conventional extension for raw 8 kHz µ-law samples.
    case "audio/basic":
      return "ulaw";
    default:
      return "bin";
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTtsCommand(program: Command): void {
  registerCommand(program, {
    name: "tts",
    transport: "ipc",
    description: "Text-to-speech operations",
    build: (ttsCmd) => {
      const builtinProviders = "elevenlabs, fish-audio, deepgram, xai";

      ttsCmd.addHelpText(
        "after",
        `
TTS commands use your configured TTS provider to synthesize text to audio.
The provider is set via:

  $ assistant config set services.tts.provider <provider>

Built-in providers: ${builtinProviders}.

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence"
  $ echo "piped input" | assistant tts synthesize`,
      );

      // ── synthesize ──────────────────────────────────────────────────────

      ttsCmd
        .command("synthesize")
        .description(
          "Synthesize text to audio using the configured TTS provider",
        )
        .option(
          "--text <text>",
          "Text to synthesize to audio (alternative: pass as positional arg or pipe via stdin)",
        )
        .option(
          "--output <path>",
          "Path to write the audio file (defaults to system temp dir with auto-generated name)",
        )
        .option(
          "--voice <id>",
          "Provider-specific voice identifier (ElevenLabs voiceId, Fish Audio referenceId, etc.) — overrides configured default",
        )
        .option(
          "--use-case <case>",
          "Synthesis use case: 'message-playback' (default, higher quality) or 'phone-call' (lower latency)",
          "message-playback",
        )
        .option("--json", "Output structured JSON instead of plain file path")
        .argument(
          "[text...]",
          "Text to synthesize (joined with spaces; alternative to --text or stdin)",
        )
        .addHelpText(
          "after",
          `
Input modes (pick one):
  --text <text>         Text to synthesize to audio.
  [text...]             Positional argument(s) joined with spaces.
  stdin                 Piped input when neither --text nor a positional is given.

Options:
  --output <path>       Path to write the audio file. When omitted, a file is
                        written to the system temp directory with a random
                        name and the extension derived from the provider's
                        returned MIME type (mp3 for ElevenLabs, wav for
                        Deepgram/Fish Audio in WAV mode). Parent directories
                        are created as needed.
  --voice <id>          Provider-specific voice identifier that overrides the
                        configured default. Format depends on the provider
                        (e.g. an ElevenLabs voiceId or a Fish Audio referenceId).
  --use-case <case>     Synthesis use case — 'message-playback' (default,
                        higher quality) or 'phone-call' (lower latency).
  --json                Output a single-line JSON object on stdout instead of
                        the plain file path. Errors are also emitted as JSON.

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence" --output /tmp/out.mp3
  $ echo "hello" | assistant tts synthesize
  $ assistant tts synthesize --text "hi" --voice <voice-id>
  $ assistant tts synthesize --text "hi" --use-case phone-call
  $ assistant tts synthesize --text "hi" --json`,
        )
        .action(
          async (
            positionalParts: string[],
            opts: {
              text?: string;
              output?: string;
              voice?: string;
              useCase: string;
              json?: boolean;
            },
            cmd: Command,
          ) => {
            const jsonOutput = opts.json ?? false;

            const emitError = (msg: string): void => {
              if (jsonOutput) {
                process.stdout.write(
                  JSON.stringify({ ok: false, error: msg }) + "\n",
                );
              } else {
                log.error(msg);
              }
            };

            // Resolve effective text from --text, positional args, or stdin.
            let messageText =
              opts.text ??
              (positionalParts.length > 0 ? positionalParts.join(" ") : "");
            if (!messageText && !process.stdin.isTTY) {
              try {
                messageText = readFileSync("/dev/stdin", "utf-8").trim();
              } catch {
                /* stdin unavailable */
              }
            }
            if (!messageText) {
              emitError(
                "No text provided. Pass --text, a positional argument, or pipe via stdin.",
              );
              process.exitCode = 1;
              return;
            }

            // Validate --use-case
            if (!VALID_USE_CASES.includes(opts.useCase as TtsUseCaseCli)) {
              emitError(
                `Invalid --use-case: '${opts.useCase}'. Must be one of: ${VALID_USE_CASES.join(", ")}.`,
              );
              process.exitCode = 1;
              return;
            }
            const useCase = opts.useCase as TtsUseCaseCli;

            // Call the daemon via IPC.
            const r = await cliIpcCall<{
              audioBase64: string;
              contentType: string;
            }>("tts_synthesize_cli", {
              body: {
                text: messageText,
                useCase,
                ...(opts.voice && { voiceId: opts.voice }),
              },
            });

            if (!r.ok) {
              if (jsonOutput) {
                emitError(r.error ?? "TTS synthesis failed");
                process.exitCode = 1;
                return;
              }
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }

            const { audioBase64, contentType } = r.result!;

            // Decode base64 audio.
            const audioBuffer = Buffer.from(audioBase64, "base64");

            // Determine output file path.
            const filePath =
              opts.output ??
              join(
                tmpdir(),
                `vellum-tts-${randomUUID()}.${extensionForMime(contentType)}`,
              );

            // Write audio to disk.
            try {
              const dir = dirname(filePath);
              if (opts.output) {
                mkdirSync(dir, { recursive: true });
              } else if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
              }

              writeFileSync(filePath, audioBuffer);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emitError(`Failed to write audio to ${filePath}: ${msg}`);
              process.exitCode = 1;
              return;
            }

            if (jsonOutput) {
              process.stdout.write(
                JSON.stringify({
                  ok: true,
                  path: filePath,
                  contentType,
                  sizeBytes: audioBuffer.length,
                }) + "\n",
              );
            } else {
              process.stdout.write(filePath + "\n");
            }
          },
        );
    },
  });
}
