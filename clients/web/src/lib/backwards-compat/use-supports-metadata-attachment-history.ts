/**
 * Backwards-compat gate for lightweight chat history attachment payloads.
 *
 * Assistants below 0.10.12 ignore or reject the `attachmentContent=metadata`
 * query parameter, so their transcripts keep requesting inline attachment
 * bytes. Assistants at 0.10.12 and above return stable attachment metadata and
 * references; the web client loads display representations near the viewport.
 *
 * The gate is scoped to the assistant that owns the transcript so a switch
 * cannot briefly apply one assistant's version to another assistant's history.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.10.12";

/** Returns whether the transcript may request metadata-only attachments. */
export function useSupportsMetadataAttachmentHistory(
  transcriptAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, transcriptAssistantId);
}
