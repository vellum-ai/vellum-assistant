/**
 * Read-only counterpart to the document viewer: the chat drawer showing a
 * workspace file the markdown editor cannot round-trip. Every non-markdown file
 * lands here, so the panel dispatches to a reader when the format has one and
 * names the file plus its way out when it does not.
 *
 * Mirrors `DocumentViewerContainer`'s shell (same panel frame, same navbar
 * rhythm, same close affordance) so switching between an editable markdown
 * file and a previewed one does not feel like landing in a different app. The
 * bytes come from the query cache under the key the inline media embeds use,
 * so a file already fetched for the transcript opens here without a second
 * request, and nothing about the file is copied into a store.
 */

import { lazy, useCallback, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, X } from "lucide-react";

import { Button, toast, Typography } from "@vellumai/design-library";

import { LazyBoundary } from "@/components/lazy-boundary";
import { formatAttachmentSize } from "@/domains/chat/components/chat-attachments/utils";
import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/domains/chat/components/local-file/local-file-icon";
import { previewByteCapFor } from "@/domains/chat/components/local-file/local-file-limits";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { PreviewUnsupported } from "@/domains/chat/components/local-file/preview/preview-unsupported";
import {
  localFileInfoQueryKey,
  useLocalFileInfo,
  workspaceFileBlobQuery,
} from "@/domains/chat/components/local-file/use-local-file-info";
import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";
import { downloadWorkspaceFile } from "@/utils/download-workspace-file";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

// Each reader is a chunk of its own: the CSV grid pulls in the virtualizer and
// the PDF reader pulls in pdf.js, neither of which belongs in the chat bundle
// for the sessions that never open one.
const CsvPreview = lazy(() =>
  import("./csv-preview").then((m) => ({ default: m.CsvPreview })),
);
const TextPreview = lazy(() =>
  import("./text-preview").then((m) => ({ default: m.TextPreview })),
);
const PdfFilePreview = lazy(() =>
  import("./pdf-file-preview").then((m) => ({ default: m.PdfFilePreview })),
);
const MediaPreview = lazy(() =>
  import("./media-preview").then((m) => ({ default: m.MediaPreview })),
);

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
    case "text":
      return <TextPreview blob={blob} filename={filename} />;
    case "pdf":
      return <PdfFilePreview blob={blob} />;
    case "image":
    case "audio":
    case "video":
      return (
        <MediaPreview blob={blob} filename={filename} kind={previewKind} />
      );
    // Handled before the bytes are ever requested; see the container below.
    case "unsupported":
      return null;
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
  // Every preview starts with the ranged probe: 512 bytes answer the file's
  // size, which decides whether reading the rest of it is worth doing at all.
  // A file past its cap is refused from the probe alone, so the bytes the
  // reader is told are too large to show are never pulled across the wire.
  const isUnsupported = previewKind === "unsupported";
  const probe = useLocalFileInfo(workspacePath, assistantId);
  const probeSizeBytes = probe.status === "ready" ? probe.sizeBytes : null;

  const maxPreviewBytes = previewByteCapFor(previewKind);
  // A server that answers the ranged read without a total leaves the size
  // unknown; the file is read in that case rather than refused on a guess.
  const oversizeBytes =
    probeSizeBytes !== null && probeSizeBytes > maxPreviewBytes
      ? probeSizeBytes
      : null;

  const {
    data: blob,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...workspaceFileBlobQuery(workspacePath, assistantId),
    enabled:
      !isUnsupported && probe.status === "ready" && oversizeBytes === null,
  });

  const queryClient = useQueryClient();
  const handleRetry = useCallback(() => {
    // Either read can be the one that failed, and the probe gates the other,
    // so a retry re-runs both.
    void queryClient.invalidateQueries({
      queryKey: localFileInfoQueryKey(workspacePath, assistantId),
    });
    void refetch();
  }, [assistantId, queryClient, refetch, workspacePath]);

  const handleOpenInWorkspace = useCallback(() => {
    void openWorkspaceFile(workspacePath);
  }, [workspacePath]);

  const handleDownload = useCallback(() => {
    void downloadWorkspaceFile({
      assistantId,
      path: workspacePath,
      filename: documentName,
    }).catch(() => {
      toast.error("Failed to download file", { description: documentName });
    });
  }, [assistantId, documentName, workspacePath]);

  // The CSV grid virtualizes its own rows, so it owns the vertical scroll and
  // the panel must not wrap it in a second scroller.
  let showsCsvGrid = false;

  let body: ReactNode;
  if (isUnsupported) {
    body = (
      <PreviewUnsupported
        filename={documentName}
        sizeBytes={probeSizeBytes}
        onOpenInWorkspace={handleOpenInWorkspace}
        onDownload={handleDownload}
      />
    );
  } else if (isError || probe.status === "unavailable") {
    body = (
      <div role="alert" className={NOTICE_CLASSES}>
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          Couldn&apos;t load this file
        </Typography>
        <Button variant="outlined" size="compact" onClick={handleRetry}>
          Try again
        </Button>
      </div>
    );
  } else if (oversizeBytes !== null) {
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
          {`${formatAttachmentSize(oversizeBytes)}, over the ${formatAttachmentSize(maxPreviewBytes)} preview limit`}
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
  } else if (probe.status === "loading" || isPending || blob === undefined) {
    body = <PreviewSkeleton />;
  } else {
    showsCsvGrid = previewKind === "csv";
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
