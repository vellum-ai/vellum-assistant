/**
 * Auto-transcribe audio attachments from channel inbound messages.
 *
 * Returns a discriminated result type so callers can handle each outcome
 * (transcribed, no audio, disabled, no provider, error) without exceptions.
 * Never throws — failures are represented as result variants so that message
 * delivery is never blocked by transcription issues.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import * as attachmentsStore from "../../../memory/attachments-store.js";
import { resolveSpeechToTextProvider } from "../../../providers/speech-to-text/resolve.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("transcribe-audio");

const VOICE_TRANSCRIPTION_FLAG_KEY = "channel-voice-transcription" as const;

/** Timeout for the entire transcription pipeline (all attachments). */
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type TranscribeResult =
  | { status: "transcribed"; text: string }
  | { status: "no_audio" }
  | { status: "disabled" }
  | { status: "no_provider"; reason: string }
  | { status: "error"; reason: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function tryTranscribeAudioAttachments(
  attachmentIds: string[],
): Promise<TranscribeResult> {
  try {
    // Check feature flag
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(VOICE_TRANSCRIPTION_FLAG_KEY, config)) {
      return { status: "disabled" };
    }

    // Look up attachments and filter to audio MIME types
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    const audioAttachments = resolved.filter((a) =>
      a.mimeType.startsWith("audio/"),
    );

    if (audioAttachments.length === 0) {
      return { status: "no_audio" };
    }

    // Resolve STT provider
    const provider = await resolveSpeechToTextProvider();
    if (!provider) {
      return {
        status: "no_provider",
        reason:
          "No OpenAI API key configured. Set one up to enable voice message transcription.",
      };
    }

    // Transcribe each audio attachment with a shared timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      TRANSCRIPTION_TIMEOUT_MS,
    );

    try {
      const transcriptions: string[] = [];

      for (const attachment of audioAttachments) {
        // Hydrate the base64 data for the attachment
        const hydrated = attachmentsStore.getAttachmentById(attachment.id, {
          hydrateFileData: true,
        });
        if (!hydrated || !hydrated.dataBase64) {
          log.warn(
            { attachmentId: attachment.id },
            "Could not hydrate audio attachment data; skipping",
          );
          continue;
        }

        const buffer = Buffer.from(hydrated.dataBase64, "base64");
        const result = await provider.transcribe(
          buffer,
          attachment.mimeType,
          abortController.signal,
        );

        if (result.text.trim()) {
          transcriptions.push(result.text.trim());
        }
      }

      if (transcriptions.length === 0) {
        return { status: "no_audio" };
      }

      return { status: "transcribed", text: transcriptions.join("\n\n") };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err: unknown) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Transcription timed out"
          : err.message
        : String(err);
    log.warn({ err }, "Audio transcription failed");
    return { status: "error", reason };
  }
}
