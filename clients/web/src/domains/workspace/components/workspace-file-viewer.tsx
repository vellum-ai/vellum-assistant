/**
 * Viewer for individual workspace files. Supports markdown (preview/source
 * toggle), JSON (pretty-printed preview), plain text, images, video, and a
 * binary-fallback metadata card. Text-based files can be edited in-place with
 * Ctrl+S / Cmd+S to save.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileIcon, FileText, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Typography } from "@vellumai/design-library";

import {
  ContentActionBar,
  EditFooter,
  FileTextarea,
  SourcePre,
} from "@/components/file-editor";
import {
  FileViewModeControl,
  type FileViewMode,
} from "@/components/file-view-mode";
import { formatLocale, useTranslation } from "@/i18n";
import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { isJson, prettifyJson } from "@/domains/workspace/utils/file-json";
import { formatFileSize } from "@/utils/format-file-size";
import { isHiddenPath } from "@/domains/workspace/utils/is-hidden-path";
import {
  workspaceFileContentGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { downloadWorkspaceFile } from "@/utils/download-workspace-file";
import { workspaceBasenameOf } from "@/utils/workspace-path-links";

import { workspaceFileRetrieveOptions } from "../utils/workspace-file-query";
import { WorkspaceFileHeader } from "./workspace-file-header";
import type { WorkspaceFilePickerControl } from "./workspace-file-switcher";

/**
 * Download state for a single workspace file — shared by the binary-fallback
 * card and the preview header's download affordance so both surfaces report
 * in-progress and failure the same way.
 */
function useWorkspaceFileDownload(opts: {
  assistantId: string;
  path: string;
  name: string;
  showHidden?: boolean;
}) {
  const { assistantId, path, name, showHidden } = opts;
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState(false);

  const download = useCallback(async () => {
    setError(false);
    setIsDownloading(true);
    try {
      await downloadWorkspaceFile({
        assistantId,
        path,
        filename: name,
        showHidden,
      });
    } catch {
      setError(true);
    } finally {
      setIsDownloading(false);
    }
  }, [assistantId, path, name, showHidden]);

  return { isDownloading, error, download };
}

/**
 * Icon-only download button for a previewed file's header. Images, video, and
 * other inline-rendered files have no other download path, so this lives in the
 * header's top-right corner alongside any view-mode controls.
 */
function HeaderDownloadButton({
  assistantId,
  path,
  name,
  showHidden,
}: {
  assistantId: string;
  path: string;
  name: string;
  showHidden?: boolean;
}) {
  const { t } = useTranslation("workspace");
  const { isDownloading, error, download } = useWorkspaceFileDownload({
    assistantId,
    path,
    name,
    showHidden,
  });
  return (
    <Button
      variant="ghost"
      size="regular"
      loading={isDownloading}
      iconOnly={<Download aria-hidden />}
      onClick={() => void download()}
      disabled={isDownloading}
      aria-label={t("workspaceFileViewer.downloadAria", { name })}
      tooltip={
        error
          ? t("workspaceFileViewer.downloadFailed")
          : t("workspaceFileViewer.download")
      }
    />
  );
}

function BinaryContentViewer({
  assistantId,
  path,
  mimeType,
  showHidden,
}: {
  assistantId: string;
  path: string;
  mimeType: string;
  showHidden?: boolean;
}) {
  const { data: blob, isLoading } = useQuery({
    queryFn: async () => {
      const res = await workspaceFileContentGet({
        path: { assistant_id: assistantId },
        query: { path, ...(showHidden ? { showHidden: "true" } : {}) },
        parseAs: "blob",
      });
      if (res.error) {
        throw res.error;
      }
      return res.data!;
    },
    queryKey: [
      "assistantsWorkspaceFileContentRetrieve",
      { assistantId, path, showHidden },
    ],
    enabled: !!path,
  });

  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [blob]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          className="h-6 w-6 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (!objectUrl) {
    return null;
  }

  if (mimeType.startsWith("image/")) {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={objectUrl}
          alt={path.split("/").pop() ?? "image"}
          className="max-h-[70vh] max-w-full rounded object-contain"
        />
      </div>
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <div className="flex items-center justify-center p-4">
        <video
          src={objectUrl}
          controls
          className="max-h-[70vh] max-w-full rounded"
        />
      </div>
    );
  }

  return null;
}

function BinaryFileCard({
  assistantId,
  path,
  name,
  mimeType,
  size,
  modifiedAt,
  showHidden,
}: {
  assistantId: string;
  path: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedAt?: string | null;
  showHidden?: boolean;
}) {
  const { t } = useTranslation("workspace");
  const {
    isDownloading,
    error,
    download: handleDownload,
  } = useWorkspaceFileDownload({ assistantId, path, name, showHidden });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center p-8">
        <div
          className="w-full max-w-sm rounded-lg border p-6 text-center"
          style={{
            borderColor: "var(--border-base)",
            backgroundColor: "var(--surface-lift)",
          }}
        >
          <FileIcon
            className="mx-auto h-10 w-10"
            style={{ color: "var(--content-tertiary)" }}
          />
          <p
            className="mt-3 text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {name}
          </p>
          <div className="mt-2 space-y-1">
            <p
              className="text-body-small-default"
              style={{
                color: "var(--content-secondary, var(--content-tertiary))",
              }}
            >
              {mimeType}
            </p>
            <p
              className="text-body-small-default"
              style={{
                color: "var(--content-secondary, var(--content-tertiary))",
              }}
            >
              {formatFileSize(size, t("workspaceFileViewer.unknownSize"))}
            </p>
            {modifiedAt && (
              <p
                className="text-body-small-default"
                style={{
                  color: "var(--content-secondary, var(--content-tertiary))",
                }}
              >
                {t("workspaceFileViewer.modifiedLabel")}{" "}
                {new Date(modifiedAt).toLocaleString(formatLocale())}
              </p>
            )}
          </div>
          <Button
            variant="outlined"
            size="compact"
            loading={isDownloading}
            leftIcon={<Download aria-hidden />}
            onClick={handleDownload}
            disabled={isDownloading}
            aria-label={t("workspaceFileViewer.downloadAria", { name })}
            className="mt-4"
          >
            {isDownloading
              ? t("workspaceFileViewer.downloading")
              : t("workspaceFileViewer.download")}
          </Button>
          {error && (
            <p
              className="mt-2 text-body-small-default"
              style={{ color: "var(--system-negative-strong)" }}
            >
              {t("workspaceFileViewer.downloadFailed")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceFileViewer({
  assistantId,
  selectedPath,
  showHidden,
  viewMode,
  onChangeViewMode,
  picker,
  pathRename,
  pathDelete,
}: {
  assistantId: string;
  selectedPath: string | null;
  showHidden?: boolean;
  viewMode: FileViewMode;
  onChangeViewMode: (mode: FileViewMode) => void;
  picker?: WorkspaceFilePickerControl;
  /** Last successful workspace rename, so edit state can follow the file. */
  pathRename?: { from: string; to: string } | null;
  /** Last successful workspace delete, so drafts for the path are discarded. */
  pathDelete?: { path: string } | null;
}) {
  const { t } = useTranslation("workspace");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    ...workspaceFileRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { path: selectedPath ?? "", showHidden },
    }),
    enabled: !!selectedPath,
  });

  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editOverride, setEditOverride] = useState<{
    path: string;
    content: string;
  } | null>(null);

  // Keep an in-progress edit attached to the file when it (or an ancestor
  // folder) is renamed — otherwise the draft is orphaned under the old path
  // and silently disappears from the editor.
  useEffect(() => {
    if (!pathRename) {
      return;
    }
    const { from, to } = pathRename;
    const remap = (p: string) =>
      p === from
        ? to
        : p.startsWith(`${from}/`)
          ? to + p.slice(from.length)
          : p;
    setEditingPath((prev) => (prev == null ? prev : remap(prev)));
    setEditOverride((prev) =>
      prev == null ? prev : { ...prev, path: remap(prev.path) },
    );
  }, [pathRename]);

  // Discard drafts tied to a deleted file (or one under a deleted folder) so
  // recreating the same path doesn't resurrect the old contents — and Save
  // can't write them into the new file.
  useEffect(() => {
    if (!pathDelete) {
      return;
    }
    const { path } = pathDelete;
    const covers = (p: string) => p === path || p.startsWith(`${path}/`);
    setEditingPath((prev) => (prev != null && covers(prev) ? null : prev));
    setEditOverride((prev) =>
      prev != null && covers(prev.path) ? null : prev,
    );
  }, [pathDelete]);

  const isEditing = editingPath != null && editingPath === selectedPath;
  const originalContent = data?.content ?? "";
  const editableContent =
    editOverride?.path === selectedPath
      ? editOverride.content
      : originalContent;

  const stopEditing = () => {
    setEditingPath(null);
    setEditOverride(null);
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      path,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      const { error, response } = await workspaceWritePost({
        path: { assistant_id: assistantId },
        body: { path, content, encoding: "utf8" },
        throwOnError: false,
      });
      if (!response?.ok || error) {
        throw new Error("Failed to save file");
      }
    },
    onSuccess: (_data, variables) => {
      setEditingPath((current) =>
        current === variables.path ? null : current,
      );
      setEditOverride((current) =>
        current?.path === variables.path ? null : current,
      );
      void queryClient.invalidateQueries({
        queryKey: ["assistantsWorkspaceFileRetrieve"],
      });
    },
  });

  const isDirty = editableContent !== originalContent;

  const handleSave = useCallback(() => {
    if (selectedPath && isDirty && !saveMutation.isPending) {
      saveMutation.mutate({ path: selectedPath, content: editableContent });
    }
  }, [selectedPath, isDirty, saveMutation, editableContent]);

  const mimeType = data?.mimeType ?? "application/octet-stream";
  const name = data?.name ?? workspaceBasenameOf(selectedPath ?? "");
  const markdown = isMarkdown(name, mimeType);
  const json = isJson(name, mimeType);
  // The backend supplies inline content for text-renderable MIME types,
  // including application/yaml, application/toml and application/x-sh.
  const readOnly = selectedPath ? isHiddenPath(selectedPath) : true;
  const hasContent = selectedPath != null && data != null && !isLoading;
  const hasViewModes = hasContent && data.content != null && (markdown || json);
  const isMedia = mimeType.startsWith("image/") || mimeType.startsWith("video/");

  function renderContent() {
    if (!selectedPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3.5 px-10 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--content-default)_6%,transparent)]">
            <FileText
              className="h-5 w-4 text-[var(--content-secondary)]"
              aria-hidden
            />
          </div>
          <Typography
            variant="body-large-lighter"
            className="text-[var(--content-tertiary)]"
          >
            {t("workspaceFileViewer.emptyTitle")}
          </Typography>
          {!picker && (
            <Typography
              variant="body-small-lighter"
              className="text-[var(--content-tertiary)]"
            >
              {t("workspaceFileViewer.selectAFile")}
            </Typography>
          )}
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2
            className="h-6 w-6 animate-spin"
            style={{ color: "var(--content-tertiary)" }}
          />
        </div>
      );
    }

    if (!data) {
      return (
        <div className="flex h-full items-center justify-center">
          <p
            className="text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {t("workspaceFileViewer.fileNotFound")}
          </p>
        </div>
      );
    }

    const editFooter = isEditing && (
      <EditFooter
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        error={saveMutation.isError ? t("workspaceFileViewer.saveFailed") : null}
        onSave={handleSave}
        onDiscard={stopEditing}
      />
    );

    if (data.content != null) {
      const sourceContent = isEditing ? editableContent : data.content;
      const formatted = hasViewModes && viewMode === "formatted";
      const previewContent = json ? prettifyJson(sourceContent) : sourceContent;
      return (
        <div className="flex h-full flex-col">
          <div className="relative flex-1 overflow-hidden">
            <ContentActionBar
              content={formatted ? previewContent : sourceContent}
              downloadContent={sourceContent}
              fileName={name}
              mimeType={mimeType}
              showEdit={!readOnly && !formatted}
              isEditing={isEditing}
              onToggleEdit={() =>
                isEditing ? stopEditing() : setEditingPath(selectedPath)
              }
            />
            {formatted && markdown ? (
              <div
                data-slot="workspace-file-preview"
                className="h-full overflow-auto px-6 py-4"
                style={{ color: "var(--content-default)" }}
              >
                <FileMarkdown content={sourceContent} />
              </div>
            ) : formatted ? (
              <SourcePre
                content={previewContent}
                readOnly
                whiteSpace="pre"
                lineNumbers={Boolean(picker)}
              />
            ) : isEditing ? (
              <FileTextarea
                value={editableContent}
                onChange={(v) =>
                  setEditOverride({ path: selectedPath, content: v })
                }
                onSave={handleSave}
              />
            ) : (
              <SourcePre
                lineNumbers={Boolean(picker)}
                whiteSpace={picker ? "pre" : "pre-wrap"}
                content={data.content}
                readOnly={readOnly}
                onStartEdit={() => setEditingPath(selectedPath)}
              />
            )}
          </div>
          {editFooter}
        </div>
      );
    }

    // Image / video
    if (isMedia) {
      return (
        <div className="flex h-full flex-col">
          <div className="flex-1 overflow-auto">
            <BinaryContentViewer
              assistantId={assistantId}
              path={selectedPath}
              mimeType={mimeType}
              showHidden={showHidden}
            />
          </div>
        </div>
      );
    }

    // Binary fallback: metadata card with download
    return (
      <BinaryFileCard
        assistantId={assistantId}
        path={selectedPath}
        name={name}
        mimeType={mimeType}
        size={data.size}
        modifiedAt={data.modifiedAt}
        showHidden={showHidden}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {picker || hasContent ? (
        <WorkspaceFileHeader
          selectedPath={selectedPath}
          name={name}
          mimeType={mimeType}
          size={data?.size}
          picker={picker}
          rightContent={
            hasViewModes ? (
              <FileViewModeControl
                mode={viewMode}
                onChange={(mode) => {
                  if (isEditing) {
                    stopEditing();
                  }
                  onChangeViewMode(mode);
                }}
              />
            ) : hasContent && data.content == null && isMedia ? (
              <HeaderDownloadButton
                assistantId={assistantId}
                path={selectedPath}
                name={name}
                showHidden={showHidden}
              />
            ) : null
          }
        />
      ) : null}
      <div className="min-h-0 flex-1">{renderContent()}</div>
    </div>
  );
}
