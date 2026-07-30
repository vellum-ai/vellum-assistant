/**
 * Where a click on a local file reference in the transcript takes the user.
 *
 * Markdown files open in the document drawer beside the chat, where they are
 * editable in place. Everything else opens in the workspace browser: the drawer
 * hosts a markdown editor, so any other text format would come back rewritten
 * by the markdown round-trip.
 */

import { useViewerStore } from "@/stores/viewer-store";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

/** Extensions the document drawer's markdown editor round-trips faithfully. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** Whether clicking `filename` should open the document drawer. */
export function opensInDocumentDrawer(filename: string): boolean {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return false;
  }
  return MARKDOWN_EXTENSIONS.has(filename.slice(dotIndex + 1).toLowerCase());
}

/**
 * Open a workspace file the assistant referenced: the document drawer for
 * markdown, the workspace browser otherwise.
 *
 * Without an assistant id there is nothing to read the file through, so those
 * callers fall back to the workspace browser, which resolves the assistant
 * itself.
 */
export function openLocalFile(
  workspacePath: string,
  filename: string,
  assistantId?: string,
): void {
  if (assistantId && opensInDocumentDrawer(filename)) {
    void useViewerStore
      .getState()
      .loadWorkspaceFileDocument(assistantId, workspacePath);
    return;
  }
  void openWorkspaceFile(workspacePath);
}
