/**
 * Where the document editor's autosave writes.
 *
 * Every document the editor hosts is a surface in the daemon's document
 * database, so the client has a single destination.
 */

import { documentsPost } from "@/generated/daemon/sdk.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** A document surface saved through the documents API. */
export interface DocumentSaveTarget {
  source: "document";
  assistantId: string;
  surfaceId: string;
  conversationId: string;
  title: string;
}

type DocumentIdentity = Pick<DocumentSaveTarget, "assistantId" | "surfaceId">;
type RetrySave = () => Promise<unknown>;
interface SaveDrain {
  save: Promise<unknown>;
  retry?: RetrySave;
  failed: boolean;
}
const pendingSaves = new Map<
  string,
  Map<RetrySave | Promise<unknown>, SaveDrain>
>();
let sessionGeneration = 0;

useResolvedAssistantsStore.subscribe((state, previous) => {
  if (state.activeAssistantId === null && previous.activeAssistantId !== null) {
    sessionGeneration += 1;
    pendingSaves.clear();
  }
});

/** Detached editors cannot save or register retries after the session ends. */
export function captureDocumentSaveSession(): () => boolean {
  const generation = sessionGeneration;
  return () => generation === sessionGeneration;
}

function documentSaveKey(target: DocumentIdentity): string {
  return JSON.stringify([target.assistantId, target.surfaceId]);
}

/** Retains failed editor drains until a retry saves their latest revision. */
export function trackDocumentSave(
  target: DocumentIdentity,
  save: Promise<unknown>,
  retry?: RetrySave,
): void {
  const key = documentSaveKey(target);
  const saves =
    pendingSaves.get(key) ?? new Map<RetrySave | Promise<unknown>, SaveDrain>();
  const owner = retry ?? save;
  const drain: SaveDrain = { save, retry, failed: false };
  saves.set(owner, drain);
  pendingSaves.set(key, saves);
  const release = () => {
    if (saves.get(owner) === drain) {
      saves.delete(owner);
    }
    if (saves.size === 0 && pendingSaves.get(key) === saves) {
      pendingSaves.delete(key);
    }
  };
  void save.then(release, () => {
    if (retry) {
      drain.failed = true;
    } else {
      release();
    }
  });
}

/** A remounted editor reads only after this document's local writes settle. */
export async function waitForDocumentSaves(
  target: DocumentIdentity,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const key = documentSaveKey(target);
  let saves = pendingSaves.get(key);
  while (saves && isCurrent()) {
    await Promise.all(
      [...saves.values()].map((drain) => {
        // The editor's retry registers a new drain under the same owner.
        return drain.failed && drain.retry ? drain.retry() : drain.save;
      }),
    );
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
