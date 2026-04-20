/**
 * CLI command group: `assistant tts`
 *
 * Text-to-speech operations using the configured TTS provider.
 * Stateless, request-response commands — no daemon dependency.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  $ assistant tts synthesize --text "announcement"`,
  );

  // ── synthesize ──────────────────────────────────────────────────────

  ttsCmd
    .command("synthesize")
    .description("Synthesize text to audio using the configured TTS provider")
    .requiredOption("--text <text>", "Text to synthesize to audio")
    .addHelpText(
      "after",
      `
Arguments:
  --text <text>   Text to synthesize to audio (required).

Writes the audio file to the system temp directory with a random name.
The file extension is derived from the provider's returned MIME type
(mp3 for ElevenLabs, wav for Deepgram/Fish Audio in WAV mode).

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize --text "announcement"`,
    )
    .action(async (opts: { text: string }) => {
      // Providers must be registered in the CLI process since the daemon is
      // a separate process and each process has its own registry.
      registerBuiltinTtsProviders();

      try {
        const result = await synthesizeText({
          text: opts.text,
          useCase: "message-playback",
        });

        const filePath = join(
          tmpdir(),
          `vellum-tts-${randomUUID()}.${extensionForMime(result.contentType)}`,
        );

        const dir = dirname(filePath);
        if (!existsSync(dir)) {
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
    });
}
