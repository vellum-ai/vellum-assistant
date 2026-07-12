/**
 * CLI command group: `assistant tts`
 *
 * Text-to-speech operations using the configured TTS provider.
 * Thin IPC wrapper — delegates synthesis to the daemon over the IPC socket.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { readStdinSync } from "../../util/read-stdin.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { ttsHelp } from "./tts.help.js";

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
    name: ttsHelp.name,
    transport: "ipc",
    description: ttsHelp.description,
    build: (ttsCmd) => {
      applyCommandHelp(ttsCmd, ttsHelp);

      // ── synthesize ──────────────────────────────────────────────────────

      subcommand(ttsCmd, "synthesize").action(
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
              messageText = readStdinSync().trim();
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
