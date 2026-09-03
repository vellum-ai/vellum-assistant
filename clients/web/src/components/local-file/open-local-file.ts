/**
 * Where a click on a local file reference in the transcript takes the user.
 *
 * With an assistant to read the file through, every reference opens read-only
 * in the drawer beside the chat, rendered by its own reader where one exists
 * and by an identity-plus-actions state where none does. Reading a file the
 * assistant just mentioned should never cost the reader their place in the
 * conversation.
 *
 * One thing is needed to reach the drawer, and a reference without it navigates
 * to the workspace browser instead, which resolves it itself: an assistant id
 * to read the file through.
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

/**
 * Extensions with a reader of their own. Formats that share a reader map to the
 * same kind: tab-separated values parse with the comma-separated reader, and
 * every plain-text format renders through one monospace view.
 *
 * Anything absent here still opens in the drawer, through the `unsupported`
 * state (see {@link drawerPreviewKindFor}).
 */
const PREVIEW_EXTENSIONS = new Map<string, WorkspaceFilePreviewKind>([
  ["csv", "csv"],
  ["tsv", "csv"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["txt", "text"],
  ["log", "text"],
  ["json", "text"],
  ["yaml", "text"],
  ["yml", "text"],
  ["xml", "text"],
  ["pdf", "pdf"],
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["svg", "image"],
  ["avif", "image"],
  ["mp3", "audio"],
  ["wav", "audio"],
  ["m4a", "audio"],
  ["ogg", "audio"],
  ["flac", "audio"],
  ["mp4", "video"],
  ["mov", "video"],
  ["webm", "video"],
  ["m4v", "video"],
]);

/** Lowercased extension of `filename`, or `null` when it has none. */
function extensionOf(filename: string): string | null {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return filename.slice(dotIndex + 1).toLowerCase();
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
 * The preview `filename` opens in: its own reader when one exists, and the
 * unsupported state otherwise. The drawer opens either way, so this never
 * returns null.
 */
function drawerPreviewKindFor(filename: string): WorkspaceFilePreviewKind {
  return previewKindFor(filename) ?? "unsupported";
}

/**
 * Where a click on a reference lands, with the ids that destination needs
 * already resolved. One pure decision, so the click, the toggle, and the hint
 * a card shows before the click can never disagree.
 *
 * The drawer has a reader for every file type, so what decides this is only
 * whether the assistant that reads the file through is on hand.
 */
export type LocalFileDestination =
  | {
      mode: "preview";
      assistantId: string;
      previewKind: WorkspaceFilePreviewKind;
    }
  | { mode: "workspace" };

export function localFileDestination(
  filename: string,
  assistantId?: string,
): LocalFileDestination {
  if (!assistantId) {
    return { mode: "workspace" };
  }
  return {
    mode: "preview",
    assistantId,
    previewKind: drawerPreviewKindFor(filename),
  };
}

/**
 * Whether a click on this reference lands in the drawer rather than navigating
 * away to the workspace page.
 */
export function usesDocumentDrawer(
  filename: string,
  assistantId?: string,
): boolean {
  return localFileDestination(filename, assistantId).mode !== "workspace";
}

/**
 * Whether the drawer is currently previewing the workspace file at
 * `workspacePath`. Pure predicate so the reactive affordance and the imperative
 * toggle below can never disagree about what "open" means.
 *
 * A document surface has no file behind it, so it matches nothing.
 */
export function isWorkspaceFileOpen(
  mainView: MainView,
  openedDocument: OpenedDocumentState | null,
  workspacePath: string,
): boolean {
  return (
    mainView === "document" &&
    openedDocument?.source === "workspace-file-preview" &&
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
 * Whether the document drawer is currently showing the document surface
 * `surfaceId`. Pure predicate so an affordance that hides itself while its own
 * document is visible and anything acting on that document can never disagree
 * about what "open" means.
 *
 * A read-only preview carries no surface id, so it matches nothing.
 *
 * This answers for the in-chat viewer only. The standalone
 * `/assistant/documents/:surfaceId` route is a separate surface that does not
 * set `mainView`, so a consumer that needs "open anywhere" also matches the
 * route.
 */
export function isDocumentOpen(
  mainView: MainView,
  openedDocument: OpenedDocumentState | null,
  surfaceId: string,
): boolean {
  return openedDocumentSurfaceId(mainView, openedDocument) === surfaceId;
}

/**
 * Reactive form of {@link isDocumentOpen}, composed over atomic selectors so
 * an affordance only re-renders when the view or the opened document changes.
 */
export function useIsDocumentOpen(surfaceId: string | null): boolean {
  const mainView = useViewerStore.use.mainView();
  const openedDocument = useViewerStore.use.openedDocumentState();
  if (surfaceId === null) {
    return false;
  }
  return isDocumentOpen(mainView, openedDocument, surfaceId);
}

/**
 * The document surface the drawer is showing, or `null` when it shows nothing
 * or a read-only preview. The identity behind {@link isDocumentOpen}, for
 * callers that need to know *which* document rather than ask about one.
 */
export function openedDocumentSurfaceId(
  mainView: MainView,
  openedDocument: OpenedDocumentState | null,
): string | null {
  if (mainView !== "document" || openedDocument?.source !== "document") {
    return null;
  }
  return openedDocument.surfaceId;
}

/**
 * Open a workspace file the assistant referenced in the drawer's read-only
 * preview.
 *
 * A reference the drawer cannot open (no assistant to read the file through)
 * falls back to the workspace browser, which resolves that itself.
 */
export function openLocalFile(
  workspacePath: string,
  filename: string,
  assistantId?: string,
): void {
  const destination = localFileDestination(filename, assistantId);
  if (destination.mode === "preview") {
    useViewerStore
      .getState()
      .openWorkspaceFilePreview(workspacePath, destination.previewKind);
    return;
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
