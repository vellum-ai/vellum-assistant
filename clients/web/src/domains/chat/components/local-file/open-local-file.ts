/**
 * Where a click on a local file reference in the transcript takes the user.
 *
 * Markdown files open in the document drawer beside the chat, where they are
 * editable in place. Formats the editor cannot round-trip but the drawer can
 * render (spreadsheets, Word and PowerPoint packages) open in the same drawer
 * as a read-only preview. Everything else opens in the workspace browser: the
 * drawer hosts a markdown editor, so any other text format would come back
 * rewritten by the markdown round-trip.
 *
 * The drawer is a toggle for the surfaces that show whether the file is open
 * (the file card), so the open/closed question is answered here too — once, as
 * a pure predicate — rather than re-derived from the store at each call site.
 */

import type {
  MainView,
  OpenedDocumentState,
  WorkspaceFilePreviewKind,
} from "@/stores/viewer-store";
import { useViewerStore } from "@/stores/viewer-store";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

/** Extensions the document drawer's markdown editor round-trips faithfully. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/**
 * Extensions the drawer renders read-only. Tab-separated values parse with the
 * same reader as comma-separated ones, so they share the `csv` preview.
 */
const PREVIEW_EXTENSIONS = new Map<string, WorkspaceFilePreviewKind>([
  ["csv", "csv"],
  ["tsv", "csv"],
  ["docx", "docx"],
  ["pptx", "pptx"],
]);

/** Lowercased extension of `filename`, or `null` when it has none. */
function extensionOf(filename: string): string | null {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

/** Whether clicking `filename` should open the document drawer's editor. */
export function opensInDocumentDrawer(filename: string): boolean {
  const extension = extensionOf(filename);
  return extension !== null && MARKDOWN_EXTENSIONS.has(extension);
}

/**
 * Which read-only preview `filename` opens in, or `null` when the drawer has
 * no reader for it.
 */
export function previewKindFor(
  filename: string,
): WorkspaceFilePreviewKind | null {
  const extension = extensionOf(filename);
  if (extension === null) {
    return null;
  }
  return PREVIEW_EXTENSIONS.get(extension) ?? null;
}

/**
 * Whether a click on this reference lands in the document drawer rather than
 * navigating away to the workspace page. Without an assistant id there is
 * nothing to read the file through, so those references always navigate.
 */
export function usesDocumentDrawer(
  filename: string,
  assistantId?: string,
): boolean {
  return (
    Boolean(assistantId) &&
    (opensInDocumentDrawer(filename) || previewKindFor(filename) !== null)
  );
}

/**
 * Whether the document drawer is currently showing the workspace file at
 * `workspacePath`, editable or as a read-only preview. Pure predicate so the
 * reactive affordance and the imperative toggle below can never disagree about
 * what "open" means.
 */
export function isWorkspaceFileOpen(
  mainView: MainView,
  openedDocument: OpenedDocumentState | null,
  workspacePath: string,
): boolean {
  return (
    mainView === "document" &&
    openedDocument !== null &&
    openedDocument.source !== "document" &&
    openedDocument.workspacePath === workspacePath
  );
}

/**
 * Reactive form of {@link isWorkspaceFileOpen}, composed over atomic selectors
 * so a card only re-renders when the view or the opened document changes.
 */
export function useIsWorkspaceFileOpen(workspacePath: string | null): boolean {
  const mainView = useViewerStore.use.mainView();
  const openedDocument = useViewerStore.use.openedDocumentState();
  if (workspacePath === null) {
    return false;
  }
  return isWorkspaceFileOpen(mainView, openedDocument, workspacePath);
}

/**
 * Open a workspace file the assistant referenced: the document drawer's editor
 * for markdown, the drawer's read-only preview for the formats it can render,
 * the workspace browser otherwise.
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
  if (assistantId) {
    if (opensInDocumentDrawer(filename)) {
      void useViewerStore
        .getState()
        .loadWorkspaceFileDocument(assistantId, workspacePath);
      return;
    }
    const previewKind = previewKindFor(filename);
    if (previewKind !== null) {
      useViewerStore
        .getState()
        .openWorkspaceFilePreview(workspacePath, previewKind);
      return;
    }
  }
  void openWorkspaceFile(workspacePath);
}

/**
 * Toggle-aware counterpart to {@link openLocalFile}, for surfaces that show
 * whether the file is currently open. Clicking a drawer-backed file that is
 * already open dismisses the drawer through the same `closeDocument` action its
 * own close button calls, so the previous view is restored identically.
 * References that navigate to the workspace have nothing to toggle.
 */
export function toggleLocalFile(
  workspacePath: string,
  filename: string,
  assistantId?: string,
): void {
  const state = useViewerStore.getState();
  if (
    usesDocumentDrawer(filename, assistantId) &&
    isWorkspaceFileOpen(
      state.mainView,
      state.openedDocumentState,
      workspacePath,
    )
  ) {
    state.closeDocument();
    return;
  }
  openLocalFile(workspacePath, filename, assistantId);
}
