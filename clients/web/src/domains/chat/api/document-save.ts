/**
 * Where the document editor's autosave writes.
 *
 * Every document the editor hosts is a surface in the daemon's document
 * database, so the client has a single destination.
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

type DocumentIdentity = Pick<DocumentSaveTarget, "assistantId" | "surfaceId">;
const pendingSaves = new Map<string, Set<Promise<unknown>>>();

function documentSaveKey(target: DocumentIdentity): string {
  return JSON.stringify([target.assistantId, target.surfaceId]);
}

/** Tracks a complete editor drain, including revisions queued during a write. */
export function trackDocumentSave(
  target: DocumentIdentity,
  save: Promise<unknown>,
): void {
  const key = documentSaveKey(target);
  const saves = pendingSaves.get(key) ?? new Set<Promise<unknown>>();
  saves.add(save);
  pendingSaves.set(key, saves);
  const release = () => {
    saves.delete(save);
    if (saves.size === 0 && pendingSaves.get(key) === saves) {
      pendingSaves.delete(key);
    }
  };
  void save.then(release, release);
}

/** A remounted editor reads only after this document's local writes settle. */
export async function waitForDocumentSaves(
  target: DocumentIdentity,
): Promise<void> {
  const key = documentSaveKey(target);
  let saves = pendingSaves.get(key);
  while (saves) {
    await Promise.all(saves);
    saves = pendingSaves.get(key);
  }
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
