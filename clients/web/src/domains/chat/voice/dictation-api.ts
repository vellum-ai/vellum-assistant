import type { DictationContext } from "@vellumai/assistant-api";

import { dictationPost } from "@/generated/daemon/sdk.gen";
import type { DictationPostResponse } from "@/generated/daemon/types.gen";

/**
 * POST /v1/dictation
 *
 * Applies explicit dictionary/snippet replacements to dictated words, or
 * requests an edit when selected text is supplied. Ordinary dictation keeps
 * the speech recognizer's wording without automatic rewriting.
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
