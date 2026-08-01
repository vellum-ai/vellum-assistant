/**
 * Where the document editor's autosave writes.
 *
 * Every document the editor hosts is a surface in the daemon's document
 * database, including one bound to a workspace markdown file. The daemon
 * writes that one through to the file itself, so the client has a single
 * destination and the transcript and the workspace cannot fork.
 */

import { documentsPost } from "@/generated/daemon/sdk.gen";

/** A document surface saved through the documents API. */
export interface DocumentSaveTarget {
  source: "document";
  assistantId: string;
  surfaceId: string;
  conversationId: string;
  title: string;
}

/** Words in a markdown body, the count the documents API stores. */
export function markdownWordCount(markdown: string): number {
  return markdown
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * Persist `markdown` to the target's backing store. Rejects when the write
 * fails so callers can keep their save indicator honest.
 */
export async function saveDocumentContent(
  target: DocumentSaveTarget,
  markdown: string,
): Promise<void> {
  await documentsPost({
    path: { assistant_id: target.assistantId },
    body: {
      surfaceId: target.surfaceId,
      conversationId: target.conversationId,
      title: target.title,
      content: markdown,
      wordCount: markdownWordCount(markdown),
    },
    throwOnError: true,
  });
}
