/**
 * Direct-from-browser TTS synthesis for the Text-to-Speech "Test" button on
 * the Models & Services settings tab.
 *
 * The web client does not have a managed TTS backend endpoint (TTS runs
 * inside the desktop daemon on macOS). To actually exercise the user's
 * configured provider + voice ID, we call each provider's public HTTPS API
 * directly from the browser using the BYO API key stored in localStorage.
 */

export interface TTSSynthesisRequest {
  provider: string;
  apiKey: string;
  voiceId: string;
  text: string;
}

export type TTSSynthesisResult =
  | { kind: "audio"; blob: Blob }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };

export async function synthesizeTTS(
  request: TTSSynthesisRequest,
): Promise<TTSSynthesisResult> {
  const { provider, apiKey, voiceId, text } = request;
  if (apiKey.trim().length === 0) {
    return {
      kind: "error",
      message: "Save an API key for this provider first.",
    };
  }

  try {
    if (provider === "elevenlabs") {
      return await synthesizeElevenLabs(apiKey, voiceId, text);
    }
    if (provider === "deepgram") {
      return await synthesizeDeepgram(apiKey, text);
    }
    if (provider === "fish-audio") {
      return {
        kind: "unsupported",
        message:
          "Fish Audio TTS is only supported in the desktop app today. Use ElevenLabs or Deepgram to test from the browser.",
      };
    }
    if (provider === "xai") {
      return {
        kind: "unsupported",
        message:
          "xAI TTS is only supported in the desktop app today. Use ElevenLabs or Deepgram to test from the browser.",
      };
    }
    return {
      kind: "unsupported",
      message: `TTS testing for "${provider}" is not supported from the browser yet.`,
    };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to reach the TTS provider.",
    };
  }
}

async function synthesizeElevenLabs(
  apiKey: string,
  voiceId: string,
  text: string,
): Promise<TTSSynthesisResult> {
  const trimmedVoiceId = voiceId.trim();
  if (trimmedVoiceId.length === 0) {
    return {
      kind: "error",
      message: "Enter and save a Voice ID before testing ElevenLabs.",
    };
  }
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      trimmedVoiceId,
    )}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
      }),
    },
  );
  if (!response.ok) {
    return {
      kind: "error",
      message: await extractErrorMessage(
        response,
        "ElevenLabs rejected the request.",
      ),
    };
  }
  return { kind: "audio", blob: await response.blob() };
}

async function synthesizeDeepgram(
  apiKey: string,
  text: string,
): Promise<TTSSynthesisResult> {
  const response = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text }),
    },
  );
  if (!response.ok) {
    return {
      kind: "error",
      message: await extractErrorMessage(
        response,
        "Deepgram rejected the request.",
      ),
    };
  }
  return { kind: "audio", blob: await response.blob() };
}

async function extractErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return `${fallback} (HTTP ${response.status})`;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === "object" &&
        "detail" in parsed &&
        typeof (parsed as { detail: unknown }).detail === "string"
      ) {
        return (parsed as { detail: string }).detail;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof (parsed as { message: unknown }).message === "string"
      ) {
        return (parsed as { message: string }).message;
      }
    } catch {
      // not JSON
    }
    return text.slice(0, 200);
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}
