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
import type { TtsUseCase } from "../../tts/types.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_USE_CASES: readonly TtsUseCase[] = [
  "message-playback",
  "phone-call",
];

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
    .addHelpText(
      "after",
      `
Arguments:
  --text <text>       Text to synthesize to audio (required).
  --voice <id>        Provider-specific voice identifier that overrides the
                      configured default. Format depends on the provider
                      (e.g. an ElevenLabs voiceId or a Fish Audio referenceId).
  --use-case <case>   Synthesis use case — 'message-playback' (default,
                      higher quality) or 'phone-call' (lower latency).
  --json              Output a single-line JSON object on stdout instead of
                      the plain file path. Errors are also emitted as JSON.

Writes the audio file to the system temp directory with a random name.
The file extension is derived from the provider's returned MIME type
(mp3 for ElevenLabs, wav for Deepgram/Fish Audio in WAV mode).

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize --text "hi" --voice <voice-id>
  $ assistant tts synthesize --text "hi" --use-case phone-call
  $ assistant tts synthesize --text "hi" --json`,
    )
    .action(
      async (opts: {
        text: string;
        voice?: string;
        useCase: string;
        json?: boolean;
      }) => {
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

        // Validate --use-case
        if (!VALID_USE_CASES.includes(opts.useCase as TtsUseCase)) {
          emitError(
            `Invalid --use-case: '${opts.useCase}'. Must be one of: ${VALID_USE_CASES.join(", ")}.`,
          );
          process.exitCode = 1;
          return;
        }
        const useCase = opts.useCase as TtsUseCase;

        // Providers must be registered in the CLI process since the daemon is
        // a separate process and each process has its own registry.
        registerBuiltinTtsProviders();

        try {
          const result = await synthesizeText({
            text: opts.text,
            useCase,
            voiceId: opts.voice,
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

          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({
                ok: true,
                path: filePath,
                contentType: result.contentType,
                sizeBytes: result.audio.length,
              }) + "\n",
            );
          } else {
            process.stdout.write(filePath + "\n");
          }
        } catch (err) {
          if (
            err instanceof TtsSynthesisError &&
            err.code === "TTS_PROVIDER_NOT_CONFIGURED"
          ) {
            emitError(
              "No TTS provider configured or registered. Run 'assistant config set services.tts.provider <provider>' to select one (e.g. elevenlabs, fish-audio, deepgram), then 'assistant keys set <provider>' to add the API key.",
            );
            process.exitCode = 1;
            return;
          }

          const msg = err instanceof Error ? err.message : String(err);
          emitError(`TTS synthesis failed: ${msg}`);
          process.exitCode = 1;
        }
      },
    );
}
