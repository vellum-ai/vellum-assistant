/**
 * CLI command group: `assistant tts`
 *
 * Text-to-speech operations using the configured TTS provider.
 * Stateless, request-response commands — no daemon dependency.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Command } from "commander";

import { registerBuiltinTtsProviders } from "../../tts/providers/register-builtins.js";
import {
  synthesizeText,
  TtsSynthesisError,
} from "../../tts/synthesize-text.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// MIME type → file extension mapping
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
    default:
      return "bin";
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTtsCommand(program: Command): void {
  const ttsCmd = program
    .command("tts")
    .description("Text-to-speech operations");

  ttsCmd.addHelpText(
    "after",
    `
TTS commands use your configured TTS provider to synthesize text to audio.
The provider is set via:

  $ assistant config set services.tts.provider <provider>

Built-in providers: elevenlabs, fish-audio, deepgram.

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence"
  $ echo "piped input" | assistant tts synthesize`,
  );

  // ── synthesize ──────────────────────────────────────────────────────

  ttsCmd
    .command("synthesize")
    .description("Synthesize text to audio using the configured TTS provider")
    .option(
      "--text <text>",
      "Text to synthesize to audio (alternative: pass as positional arg or pipe via stdin)",
    )
    .option(
      "--output <path>",
      "Path to write the audio file (defaults to system temp dir with auto-generated name)",
    )
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

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence" --output /tmp/out.mp3
  $ echo "hello" | assistant tts synthesize`,
    )
    .action(
      async (
        positionalParts: string[],
        opts: { text?: string; output?: string },
      ) => {
        // Resolve effective text from --text, positional args, or stdin.
        let messageText =
          opts.text ??
          (positionalParts.length > 0 ? positionalParts.join(" ") : "");
        if (!messageText) {
          try {
            messageText = readFileSync("/dev/stdin", "utf-8").trim();
          } catch {
            /* stdin unavailable */
          }
        }
        if (!messageText) {
          log.error(
            "No text provided. Pass --text, a positional argument, or pipe via stdin.",
          );
          process.exitCode = 1;
          return;
        }

        // Providers must be registered in the CLI process since the daemon is
        // a separate process and each process has its own registry.
        registerBuiltinTtsProviders();

        try {
          const result = await synthesizeText({
            text: messageText,
            useCase: "message-playback",
          });

          const filePath =
            opts.output ??
            join(
              tmpdir(),
              `vellum-tts-${randomUUID()}.${extensionForMime(result.contentType)}`,
            );

          const dir = dirname(filePath);
          if (opts.output) {
            mkdirSync(dir, { recursive: true });
          } else if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          writeFileSync(filePath, result.audio);
          process.stdout.write(filePath + "\n");
        } catch (err) {
          if (
            err instanceof TtsSynthesisError &&
            err.code === "TTS_PROVIDER_NOT_CONFIGURED"
          ) {
            log.error(
              "No TTS provider configured or registered. Run 'assistant config set services.tts.provider <provider>' to select one (e.g. elevenlabs, fish-audio, deepgram), then 'assistant keys set <provider>' to add the API key.",
            );
            process.exitCode = 1;
            return;
          }

          const msg = err instanceof Error ? err.message : String(err);
          log.error(`TTS synthesis failed: ${msg}`);
          process.exitCode = 1;
        }
      },
    );
}
