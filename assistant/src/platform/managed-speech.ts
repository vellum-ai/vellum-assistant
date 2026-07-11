/**
 * Client for the platform's managed speech endpoints: Vellum-held Deepgram
 * key, billed to the org's credits. The daemon sends complete audio (STT) or
 * text (TTS) and the platform does the provider call — no speech credentials
 * ever live on this machine.
 *
 * Contract (mirrors `vellum-assistant-platform` — do not change unilaterally):
 * - `POST /v1/assistants/{id}/managed-speech/stt/transcribe/`
 *   `{audioBase64, mimeType, source?}` → 200 `{text, providerId, model,
 *   durationSeconds}`.
 * - `POST /v1/assistants/{id}/managed-speech/tts/synthesize/`
 *   `{text, format?}` → 200 binary audio, `Content-Type` from upstream.
 * - Errors: `{code, detail}`; notable codes: `insufficient_balance` (402),
 *   `missing_price` (400), `provider_configuration_error` (500).
 *
 * Pure platform HTTP client: no provider-catalog, config-schema, or resolver
 * imports — the vellum STT/TTS providers build on top of it.
 */

import { VellumPlatformClient } from "./client.js";

export type ManagedSpeechResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "unavailable" | "platform-error";
      status?: number;
      /** Platform error code (e.g. `insufficient_balance`) when the body carried one. */
      code?: string;
      message: string;
    };

export interface ManagedSpeechTranscription {
  text: string;
  durationSeconds: number;
}

export interface ManagedSpeechSynthesis {
  audio: Buffer;
  contentType: string;
}

export type ManagedSpeechTtsFormat = "mp3" | "wav_8000" | "pcm_16000";

async function resolveClient(): Promise<
  { client: VellumPlatformClient } | { error: ManagedSpeechResult<never> }
> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    return {
      error: {
        ok: false,
        kind: "unavailable",
        message:
          "Managed speech is unavailable: no Vellum platform connection.",
      },
    };
  }
  if (!client.platformAssistantId) {
    return {
      error: {
        ok: false,
        kind: "unavailable",
        message:
          "Managed speech is unavailable: platform assistant ID is missing.",
      },
    };
  }
  return { client };
}

/**
 * Whether managed speech can be used at all: a platform connection whose
 * assistant identity is fully provisioned. A stored API key alone is not
 * enough — synthesis/transcription would fail before any request is made.
 */
export async function managedSpeechAvailable(): Promise<boolean> {
  return !("error" in (await resolveClient()));
}

export async function managedSpeechTranscribe(input: {
  audio: Buffer;
  mimeType: string;
  source?: string;
  signal?: AbortSignal;
}): Promise<ManagedSpeechResult<ManagedSpeechTranscription>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/managed-speech/stt/transcribe/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: input.audio.toString("base64"),
        mimeType: input.mimeType,
        ...(input.source !== undefined ? { source: input.source } : {}),
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return await platformError(response, "transcription");
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { text?: unknown }).text !== "string" ||
    typeof (body as { durationSeconds?: unknown }).durationSeconds !== "number"
  ) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Managed speech transcription returned a malformed response.",
    };
  }
  const parsed = body as { text: string; durationSeconds: number };
  return {
    ok: true,
    value: { text: parsed.text, durationSeconds: parsed.durationSeconds },
  };
}

export async function managedSpeechSynthesize(input: {
  text: string;
  format: ManagedSpeechTtsFormat;
  signal?: AbortSignal;
}): Promise<ManagedSpeechResult<ManagedSpeechSynthesis>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/managed-speech/tts/synthesize/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.text, format: input.format }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return await platformError(response, "synthesis");
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Managed speech synthesis returned empty audio.",
    };
  }
  return {
    ok: true,
    value: {
      audio,
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
    },
  };
}

async function platformError(
  response: Response,
  operation: string,
): Promise<ManagedSpeechResult<never>> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const body = (await response.json()) as {
      code?: unknown;
      detail?: unknown;
    };
    if (typeof body?.code === "string") {
      code = body.code;
    }
    if (typeof body?.detail === "string") {
      detail = body.detail;
    }
  } catch {
    // Non-JSON error body; status alone will have to do.
  }
  return {
    ok: false,
    kind: "platform-error",
    status: response.status,
    code,
    message:
      detail ??
      `Managed speech ${operation} failed (platform returned ${response.status}).`,
  };
}
