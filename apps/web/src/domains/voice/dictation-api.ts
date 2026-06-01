import type { DictationContext } from "@vellumai/assistant-api";

import { dictationPost } from "@/generated/daemon/sdk.gen";
import type { DictationPostResponse } from "@/generated/daemon/types.gen";

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
): Promise<DictationPostResponse | null> {
  try {
    const { data, response } = await dictationPost({
      path: { assistant_id: assistantId },
      body: { transcription, context },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
