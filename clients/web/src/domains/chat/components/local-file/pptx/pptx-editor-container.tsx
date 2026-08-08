/**
 * The full-screen PowerPoint editor.
 *
 * Stepping up from the drawer's read-only preview: the same presentation, the
 * same bytes out of the same query cache, but the viewer's full editing surface
 * and the whole content area to work in. Mirrors how the app viewer treats
 * editing — a distinct `mainView` rather than a mode flag on the drawer — so
 * Escape, the back affordance, and the browser's own history all behave the way
 * they already do for apps.
 *
 * PROTOTYPE: edits live in memory only. `onContentChange` tracks the dirty
 * buffer so the UI can say the deck has unsaved changes, but nothing writes
 * back to the workspace file yet — that needs a workspace write endpoint and a
 * conflict story, neither of which exists for binary files today.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleDot } from "lucide-react";
import { PowerPointViewer } from "pptx-react-viewer";

import { Button, Typography } from "@vellumai/design-library";

import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { usePptxBytes } from "@/domains/chat/components/local-file/pptx/use-pptx-bytes";
import { workspaceFileBlobQuery } from "@/domains/chat/components/local-file/use-local-file-info";

import "pptx-react-viewer/styles.css";

interface PptxEditorContainerProps {
  assistantId: string;
  workspacePath: string;
  documentName: string;
  /** Return to the drawer preview this editor was expanded from. */
  onExit: () => void;
}

export function PptxEditorContainer({
  assistantId,
  workspacePath,
  documentName,
  onExit,
}: PptxEditorContainerProps): ReactNode {
  // Same cache entry the drawer preview read, so expanding a deck that was
  // already on screen costs no second fetch.
  const { data: blob, isError } = useQuery(
    workspaceFileBlobQuery(workspacePath, assistantId),
  );
  const decoded = usePptxBytes(blob);
  const state = isError ? ({ status: "error" } as const) : decoded;
  const [isDirty, setIsDirty] = useState(false);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  let body: ReactNode;
  if (state.status === "loading") {
    body = <PreviewSkeleton />;
  } else if (state.status === "error") {
    body = (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3"
      >
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          Couldn&apos;t open this presentation
        </Typography>
        <Button variant="outlined" size="compact" onClick={onExit}>
          Back to preview
        </Button>
      </div>
    );
  } else {
    body = (
      <PowerPointViewer
        content={state.bytes}
        fileName={documentName}
        filePath={workspacePath}
        canEdit
        onDirtyChange={handleDirtyChange}
        className="h-full w-full"
      />
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--surface-overlay)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2">
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<ArrowLeft />}
          onClick={onExit}
        >
          Back
        </Button>

        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
          title={workspacePath}
        >
          {documentName}
        </Typography>

        {isDirty ? (
          <span className="flex items-center gap-1 text-[var(--content-tertiary)]">
            <CircleDot className="h-3 w-3" aria-hidden />
            <Typography as="span" variant="label-small-default">
              Unsaved changes (not written to disk in this prototype)
            </Typography>
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}
