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

import { z } from "zod";

import { VellumPlatformClient } from "./client.js";

export type ManagedSpeechResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "unavailable" | "platform-error";
      status?: number;
      /** Platform error code (e.g. `insufficient_balance`) when the body carried one. */
      code?: string;
      /**
       * Platform-supplied human-readable message, present only when the error
       * body carried a `detail` field. Absent when the failure fell back to a
       * bare HTTP status. `message` mirrors this when set; callers use the
       * presence of `detail` to distinguish real platform copy (safe to surface
       * verbatim) from the generic status fallback.
       */
      detail?: string;
      message: string;
    };

export interface ManagedSpeechTranscription {
  text: string;
  durationSeconds: number;
}

const ManagedSpeechTranscriptionSchema = z.object({
  text: z.string(),
  durationSeconds: z.number(),
});

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
  /**
   * Spoken language to decode: a BCP-47 code, or `"multi"` for nova-3
   * code-switching. Omitted means the platform sends none, which Deepgram
   * decodes as English rather than detecting the language. Older platform
   * builds that predate the field ignore it, so sending one is safe before
   * the platform side deploys.
   */
  language?: string;
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
        ...(input.language ? { language: input.language } : {}),
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return await platformError(response, "transcription");
  }

  const parsed = ManagedSpeechTranscriptionSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Managed speech transcription returned a malformed response.",
    };
  }
  return {
    ok: true,
    value: {
      text: parsed.data.text,
      durationSeconds: parsed.data.durationSeconds,
    },
  };
}

export async function managedSpeechSynthesize(input: {
  text: string;
  format: ManagedSpeechTtsFormat;
  /** Voice model (e.g. "aura-2-thalia-en"); omitted = platform default. */
  model?: string;
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
      body: JSON.stringify({
        text: input.text,
        format: input.format,
        ...(input.model !== undefined ? { model: input.model } : {}),
      }),
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

export interface ManagedSpeechVoice {
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  /** Upstream provider that synthesizes this voice (e.g. "deepgram"). */
  source: string;
}

export interface ManagedSpeechVoiceCatalog {
  /** Offered voices in display order; only currently-usable voices. */
  voices: ManagedSpeechVoice[];
  /** Always one of `voices`; null when no voices are offered. */
  defaultModel: string | null;
}

const ManagedSpeechVoiceSchema = z.object({
  model: z.string(),
  label: z.string(),
  description: z.string(),
  sampleUrl: z.string(),
  source: z.string(),
});
const ManagedSpeechVoiceCatalogSchema = z.object({
  voices: z.array(ManagedSpeechVoiceSchema.nullable().catch(null)),
  defaultModel: z.string().nullable().optional().catch(null),
});
const ManagedSpeechErrorSchema = z.object({
  code: z.string().optional().catch(undefined),
  detail: z.string().optional().catch(undefined),
});

export async function managedSpeechVoices(input?: {
  signal?: AbortSignal;
}): Promise<ManagedSpeechResult<ManagedSpeechVoiceCatalog>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/managed-speech/tts/voices/`,
    { method: "GET", signal: input?.signal },
  );

  if (!response.ok) {
    return await platformError(response, "voice listing");
  }

  const parsed = ManagedSpeechVoiceCatalogSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Managed speech voice listing returned a malformed response.",
    };
  }
  return {
    ok: true,
    value: {
      voices: parsed.data.voices.filter(
        (voice): voice is ManagedSpeechVoice => voice !== null,
      ),
      defaultModel: parsed.data.defaultModel ?? null,
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
    const parsed = ManagedSpeechErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.code;
      detail = parsed.data.detail;
    }
  } catch {
    // Non-JSON error body; status alone will have to do.
  }
  return {
    ok: false,
    kind: "platform-error",
    status: response.status,
    code,
    detail,
    message:
      detail ??
      `Managed speech ${operation} failed (platform returned ${response.status}).`,
  };
}
