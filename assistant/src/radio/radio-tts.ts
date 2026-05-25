import { storeAudio } from "../calls/audio-store.js";
import { sanitizeForTts } from "../calls/tts-text-sanitizer.js";
import { synthesizeText, TtsSynthesisError } from "../tts/synthesize-text.js";
import type { RadioDjBreak, RadioSetupReason } from "./types.js";

type AudioFormat = "mp3" | "wav" | "opus" | "pcm";

export const RADIO_TTS_SETTINGS_PATH = "/assistant/settings/ai" as const;

export class RadioTtsSetupRequiredError extends Error {
  readonly settingsPath = RADIO_TTS_SETTINGS_PATH;

  constructor(
    readonly reason: RadioSetupReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RadioTtsSetupRequiredError";
  }
}

export class RadioTtsEmptyTextError extends Error {
  constructor() {
    super("Radio DJ break has no speakable text after sanitization.");
    this.name = "RadioTtsEmptyTextError";
  }
}

export function audioFormatFromContentType(contentType: string): AudioFormat {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();

  switch (normalized) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
      return "wav";
    case "audio/opus":
      return "opus";
    case "audio/pcm":
      return "pcm";
    default:
      return "mp3";
  }
}

export async function synthesizeRadioDjBreak(
  text: string,
  signal?: AbortSignal,
): Promise<RadioDjBreak> {
  const sanitized = sanitizeForTts(text).trim();
  if (!sanitized) {
    throw new RadioTtsEmptyTextError();
  }

  try {
    const result = await synthesizeText({
      text: sanitized,
      useCase: "message-playback",
      signal,
    });
    const format = audioFormatFromContentType(result.contentType);
    const audioId = storeAudio(result.audio, format);

    return {
      text: sanitized,
      audioId,
      audioPath: `audio/${audioId}`,
      contentType: result.contentType,
    };
  } catch (cause) {
    if (
      cause instanceof TtsSynthesisError &&
      cause.code === "TTS_PROVIDER_NOT_CONFIGURED"
    ) {
      throw new RadioTtsSetupRequiredError(
        "tts_not_configured",
        "Text to speech is not configured. Open Settings -> AI to configure it.",
        { cause },
      );
    }

    throw new RadioTtsSetupRequiredError(
      "tts_unavailable",
      "Text to speech is unavailable. Open Settings -> AI to check your configuration.",
      { cause },
    );
  }
}

export function isRadioTtsSetupRequiredError(
  error: unknown,
): error is RadioTtsSetupRequiredError {
  return error instanceof RadioTtsSetupRequiredError;
}
