/**
 * Where the document editor's autosave writes.
 *
 * The editor hosts two kinds of document: a surface stored in the daemon's
 * document database, and a markdown file in the assistant workspace. They save
 * to different endpoints, and sending one to the other's endpoint would fork
 * the content away from what the user is looking at, so the destination is a
 * discriminated union resolved once per save.
 */

import { documentsPost, workspaceWritePost } from "@/generated/daemon/sdk.gen";

/** A document surface saved through the documents API. */
export interface DbDocumentSaveTarget {
  source: "document";
  assistantId: string;
  surfaceId: string;
  conversationId: string;
  title: string;
}

/** A workspace file saved by rewriting the file itself. */
export interface WorkspaceFileSaveTarget {
  source: "workspace-file";
  assistantId: string;
  workspacePath: string;
}

export type DocumentSaveTarget =
  | DbDocumentSaveTarget
  | WorkspaceFileSaveTarget;

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
  if (target.source === "workspace-file") {
    const { error, response } = await workspaceWritePost({
      path: { assistant_id: target.assistantId },
      body: {
        path: target.workspacePath,
        content: markdown,
        encoding: "utf8",
      },
      throwOnError: false,
    });
    if (!response?.ok || error) {
      throw new Error("Failed to save file");
    }
    return;
  }

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
