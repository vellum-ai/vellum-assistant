/**
 * Backwards-compat gate for progressive transcript attachment loading.
 *
 * Assistants below 0.10.12 may not understand either the
 * `attachmentContent=metadata` history query or the `representation=display`
 * content query. Their transcripts keep requesting inline history payloads,
 * and referenced-image fallbacks use the content endpoint's default original
 * representation. Assistants at 0.10.12 and above return stable attachment
 * metadata and serve display representations near the viewport.
 *
 * The gate is scoped to the assistant that owns the transcript so a switch
 * cannot briefly apply one assistant's version to another assistant's history.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.10.12";

/** Returns whether the transcript may use progressive attachment requests. */
export function useSupportsProgressiveAttachmentLoading(
  transcriptAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, transcriptAssistantId);
}
