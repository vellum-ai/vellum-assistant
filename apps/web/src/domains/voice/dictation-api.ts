import { client } from "@/generated/api/client.gen.js";

// `/v1/dictation` is not yet in the OpenAPI schema, so we fall through to
// the low-level HeyAPI client until it's generated.
const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export interface DictationContext {
  cursorInTextField?: boolean;
}

export interface DictationResult {
  text: string;
  mode: "dictation" | "action";
}

/**
 * POST /v1/dictation
 *
 * Sends a raw voice transcript to the daemon for cleanup (punctuation,
 * filler-word removal, style normalisation) and intent classification.
 * Returns the cleaned text and whether the daemon classified this as a
 * "dictation" (insert into text field) or "action" (command-style intent).
 *
 * Mirrors the macOS DictationClient's transforming phase.
 */
export async function postDictation(
  transcription: string,
  assistantId: string,
  context: DictationContext = {},
  signal?: AbortSignal,
): Promise<DictationResult | null> {
  try {
    const { data, response } = await client.post<DictationResult, unknown>({
      ...SDK_BASE_OPTIONS,
      url: `/v1/assistants/${assistantId}/dictation`,
      body: { transcription, context },
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok) return null;
    return data as DictationResult;
  } catch {
    return null;
  }
}
