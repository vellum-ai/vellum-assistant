/**
 * Read-only counterpart to the document viewer: the chat drawer showing a
 * workspace file the markdown editor cannot round-trip.
 *
 * Mirrors `DocumentViewerContainer`'s shell (same panel frame, same navbar
 * rhythm, same close affordance) so switching between an editable markdown
 * file and a previewed one does not feel like landing in a different app. The
 * bytes come from the query cache under the key the inline media embeds use,
 * so a file already fetched for the transcript opens here without a second
 * request, and nothing about the file is copied into a store.
 */

import { lazy, useCallback, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";

import { Button, toast, Typography } from "@vellumai/design-library";

import { LazyBoundary } from "@/components/lazy-boundary";
import { formatAttachmentSize } from "@/domains/chat/components/chat-attachments/utils";
import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/domains/chat/components/local-file/local-file-icon";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { workspaceFileBlobQuery } from "@/domains/chat/components/local-file/use-local-file-info";
import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";
import { downloadWorkspaceFile } from "@/utils/download-workspace-file";

// Each reader is a chunk of its own: the CSV grid pulls in the virtualizer and
// the OOXML readers pull in a zip reader plus their own parsers, none of which
// belong in the chat bundle for the sessions that never open one.
const CsvPreview = lazy(() =>
  import("./csv-preview").then((m) => ({ default: m.CsvPreview })),
);
const DocxPreview = lazy(() =>
  import("./docx-preview").then((m) => ({ default: m.DocxPreview })),
);
const PptxPreview = lazy(() =>
  import("./pptx-preview").then((m) => ({ default: m.PptxPreview })),
);

/**
 * Above this the preview is refused. Parsing a file this size holds the whole
 * thing plus its parsed form in memory, and the reader is better served by
 * downloading it and opening it in the app that owns the format.
 */
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

const NOTICE_CLASSES =
  "flex flex-col items-start gap-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3";

interface FilePreviewContainerProps {
  assistantId: string;
  workspacePath: string;
  documentName: string;
  previewKind: WorkspaceFilePreviewKind;
  onClose: () => void;
}

function previewFor(
  previewKind: WorkspaceFilePreviewKind,
  blob: Blob,
  filename: string,
): ReactNode {
  switch (previewKind) {
    case "csv":
      return <CsvPreview blob={blob} filename={filename} />;
    case "docx":
      return <DocxPreview blob={blob} filename={filename} />;
    case "pptx":
      return <PptxPreview blob={blob} filename={filename} />;
    default: {
      const _exhaustive: never = previewKind;
      void _exhaustive;
      return null;
    }
  }
}

export function FilePreviewContainer({
  assistantId,
  workspacePath,
  documentName,
  previewKind,
  onClose,
}: FilePreviewContainerProps): ReactNode {
  const {
    data: blob,
    isPending,
    isError,
    refetch,
  } = useQuery(workspaceFileBlobQuery(workspacePath, assistantId));

  const handleDownload = useCallback(() => {
    void downloadWorkspaceFile({
      assistantId,
      path: workspacePath,
      filename: documentName,
    }).catch(() => {
      toast.error("Failed to download file", { description: documentName });
    });
  }, [assistantId, documentName, workspacePath]);

  const isTooLarge = blob !== undefined && blob.size > MAX_PREVIEW_BYTES;
  // The CSV grid virtualizes its own rows, so it owns the vertical scroll and
  // the panel must not wrap it in a second scroller.
  const showsCsvGrid =
    previewKind === "csv" && !isError && !isPending && !isTooLarge;

  let body: ReactNode;
  if (isError) {
    body = (
      <div role="alert" className={NOTICE_CLASSES}>
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          Couldn&apos;t load this file
        </Typography>
        <Button
          variant="outlined"
          size="compact"
          onClick={() => void refetch()}
        >
          Try again
        </Button>
      </div>
    );
  } else if (isPending || blob === undefined) {
    body = <PreviewSkeleton />;
  } else if (isTooLarge) {
    body = (
      <div role="status" className={NOTICE_CLASSES}>
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          This file is too large to preview
        </Typography>
        <Typography
          as="span"
          variant="label-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {`${formatAttachmentSize(blob.size)}, over the ${formatAttachmentSize(MAX_PREVIEW_BYTES)} preview limit`}
        </Typography>
        <Button
          variant="outlined"
          size="compact"
          leftIcon={<Download />}
          onClick={handleDownload}
        >
          Download
        </Button>
      </div>
    );
  } else {
    body = (
      <LazyBoundary fallback={<PreviewSkeleton />}>
        {previewFor(previewKind, blob, documentName)}
      </LazyBoundary>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/* Navbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2">
        <LocalFileIcon
          kind={localFileKindFromFilename(documentName)}
          filename={documentName}
          className="h-4 w-4 shrink-0 text-[var(--content-secondary)]"
        />
        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
          // The full path tells the user which file on disk they are reading.
          title={workspacePath}
        >
          {documentName}
        </Typography>

        <Button
          variant="ghost"
          size="compact"
          iconOnly={<Download />}
          onClick={handleDownload}
          aria-label={`Download ${documentName}`}
          tooltip="Download"
        />

        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close preview"
          tooltip="Close"
        />
      </div>

      {/* Body */}
      <div
        className={
          showsCsvGrid
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto p-4"
        }
      >
        {body}
      </div>
    </div>
  );
}
