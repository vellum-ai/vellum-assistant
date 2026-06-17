/**
 * Viewer for individual workspace files. Supports markdown (preview/source
 * toggle), JSON (pretty-printed preview), plain text, images, video, and a
 * binary-fallback metadata card. Text-based files can be edited in-place with
 * Ctrl+S / Cmd+S to save.
 */

import {
    queryOptions,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import {
    Check,
    Copy,
    Download,
    FileIcon,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    Loader2,
    Pencil,
    Video,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";

import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { isJson, prettifyJson } from "@/domains/workspace/utils/file-json";
import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import { isHiddenPath } from "@/domains/workspace/utils/is-hidden-path";
import {
    workspaceFileContentGet,
    workspaceFileGet,
    workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import type { WorkspaceFileGetResponse } from "@/generated/daemon/types.gen";
import { Button } from "@vellumai/design-library/components/button";

import type { WorkspaceViewMode } from "@/domains/workspace/components/workspace-browser";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function workspaceFileRetrieveOptions(opts: {
  path: { assistant_id: string };
  query: { path: string; showHidden?: boolean };
}) {
  return queryOptions<WorkspaceFileGetResponse>({
    queryFn: async () => {
      const { data, error } = await workspaceFileGet({
        path: opts.path,
        query: {
          path: opts.query.path,
          ...(opts.query.showHidden ? { showHidden: "true" } : {}),
        },
      });
      if (error) throw error;
      return data!;
    },
    queryKey: ["assistantsWorkspaceFileRetrieve", opts],
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileHeaderIcon({ mimeType }: { mimeType: string }) {
  const semi = mimeType.indexOf(";");
  const baseMime = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim();
  let Icon = FileText;
  if (baseMime.startsWith("image/")) Icon = ImageIcon;
  else if (baseMime.startsWith("video/")) Icon = Video;
  else if (
    !baseMime.startsWith("text/") &&
    baseMime !== "application/json" &&
    baseMime !== "application/octet-stream"
  ) {
    Icon = FileIcon;
  }
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 10%, transparent)",
      }}
    >
      <Icon
        className="h-3.5 w-3.5"
        style={{ color: "var(--content-default)" }}
      />
    </span>
  );
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: WorkspaceViewMode;
  onChange: (mode: WorkspaceViewMode) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md p-0.5"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 6%, transparent)",
      }}
    >
      {(["preview", "source"] as const).map((mode) => {
        const active = viewMode === mode;
        return (
          <Button
            key={mode}
            variant="ghost"
            onClick={() => onChange(mode)}
            className="h-auto rounded border-0 px-2.5 py-1 text-body-small-default hover:bg-transparent"
            style={{
              backgroundColor: active ? "var(--surface-lift)" : "transparent",
              color: active
                ? "var(--content-default)"
                : "var(--content-tertiary)",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.15)" : undefined,
            }}
          >
            {mode === "preview" ? "Preview" : "Source"}
          </Button>
        );
      })}
    </div>
  );
}

function FileHeader({
  name,
  mimeType,
  size,
  rightContent,
}: {
  name: string;
  mimeType: string;
  size?: number;
  rightContent?: ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-b px-3 py-2.5"
      style={{ borderColor: "var(--border-element)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FileHeaderIcon mimeType={mimeType} />
        <span
          className="truncate text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {name}
        </span>
        {size != null && (
          <span
            className="shrink-0 text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formatFileSize(size)}
          </span>
        )}
      </div>
      {rightContent}
    </div>
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
      if (res.error) throw res.error;
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
    if (!blob) return;
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

  if (!objectUrl) return null;

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

function EditFooter({
  isDirty,
  isSaving,
  onSave,
  onDiscard,
}: {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="flex items-center justify-end gap-2 border-t px-3 py-2"
      style={{ borderColor: "var(--border-element)" }}
    >
      <Button
        variant="ghost"
        size="compact"
        disabled={isSaving}
        onClick={onDiscard}
      >
        Discard
      </Button>
      {isSaving && (
        <Loader2
          className="h-4 w-4 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      )}
      <Button
        variant="primary"
        size="compact"
        disabled={!isDirty || isSaving}
        onClick={onSave}
      >
        Save
      </Button>
    </div>
  );
}

function ContentActionBar({
  content,
  downloadContent,
  fileName,
  mimeType,
  showEdit,
  isEditing,
  onToggleEdit,
}: {
  content: string;
  downloadContent?: string;
  fileName: string;
  mimeType: string;
  showEdit: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const rawContent = downloadContent ?? content;
  const handleDownload = useCallback(() => {
    const blob = new Blob([rawContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [rawContent, fileName, mimeType]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  if (isEditing) {
    return null;
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md bg-[var(--surface-primary)] shadow-sm">
      {showEdit && (
        <Button
          variant="ghost"
          size="regular"
          iconOnly={<Pencil aria-hidden />}
          onClick={onToggleEdit}
          aria-label="Edit file"
          className="hover:bg-[var(--surface-base)]"
        />
      )}
      <Button
        variant="ghost"
        size="regular"
        iconOnly={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy file contents"}
        className="hover:bg-[var(--surface-base)]"
      />
      <Button
        variant="ghost"
        size="regular"
        iconOnly={<Download aria-hidden />}
        onClick={handleDownload}
        aria-label="Download file"
        className="hover:bg-[var(--surface-base)]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Textarea editor — shared across markdown source, JSON source, and plain text
// ---------------------------------------------------------------------------

const MONO_FONT =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

function FileTextarea({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <textarea
      className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
      style={{ color: "var(--content-default)", fontFamily: MONO_FONT }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          onSave();
        }
      }}
      spellCheck={false}
    />
  );
}

function SourcePre({
  content,
  readOnly,
  whiteSpace = "pre-wrap",
  onStartEdit,
}: {
  content: string;
  readOnly: boolean;
  whiteSpace?: "pre" | "pre-wrap";
  onStartEdit?: () => void;
}) {
  return (
    <pre
      className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
      style={{
        color: "var(--content-default)",
        fontFamily: MONO_FONT,
        whiteSpace,
      }}
      onClick={!readOnly ? onStartEdit : undefined}
    >
      {content}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function WorkspaceFileViewer({
  assistantId,
  selectedPath,
  showHidden,
  viewMode,
  onChangeViewMode,
  onBrowse,
  pathRename,
  pathDelete,
}: {
  assistantId: string;
  selectedPath: string | null;
  showHidden?: boolean;
  viewMode: WorkspaceViewMode;
  onChangeViewMode: (mode: WorkspaceViewMode) => void;
  onBrowse?: () => void;
  /** Last successful workspace rename, so edit state can follow the file. */
  pathRename?: { from: string; to: string } | null;
  /** Last successful workspace delete, so drafts for the path are discarded. */
  pathDelete?: { path: string } | null;
}) {
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
    if (!pathRename) return;
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
    if (!pathDelete) return;
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

  // --- Empty / loading / error states ---

  if (!selectedPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p
          className="text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          Select a file to view
        </p>
        {onBrowse && (
          <Button
            type="button"
            onClick={onBrowse}
            leftIcon={<FolderOpen aria-hidden />}
            className="sm:hidden"
          >
            Browse files
          </Button>
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
          File not found
        </p>
      </div>
    );
  }

  // --- Render file content ---

  const mimeType = data.mimeType ?? "application/octet-stream";
  const name = data.name ?? selectedPath.split("/").pop() ?? selectedPath;
  const markdown = isMarkdown(name, mimeType);
  const json = isJson(name, mimeType);
  // The backend returns inline `content` for all text-renderable files,
  // including non-text/* MIME types like application/yaml, application/toml,
  // application/x-sh. Markdown and JSON are checked first in the rendering
  // cascade, so this catch-all is safe.
  const isText = data.content != null && !markdown && !json;
  const readOnly = selectedPath ? isHiddenPath(selectedPath) : true;

  const editFooter = isEditing && (
    <EditFooter
      isDirty={isDirty}
      isSaving={saveMutation.isPending}
      onSave={handleSave}
      onDiscard={stopEditing}
    />
  );

  // Markdown: Preview/Source toggle
  if (markdown && data.content != null) {
    const sourceContent = isEditing ? editableContent : data.content;
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          rightContent={
            <ViewModeToggle
              viewMode={viewMode}
              onChange={(mode) => {
                if (isEditing) stopEditing();
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={sourceContent}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly && viewMode === "source"}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {viewMode === "preview" ? (
            <div
              className="h-full overflow-auto px-6 py-4"
              style={{ color: "var(--content-default)" }}
            >
              <FileMarkdown content={sourceContent} />
            </div>
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

  // JSON: Preview (pretty-printed) / Source (raw) toggle
  if (json && data.content != null) {
    const sourceContent = isEditing ? editableContent : data.content;
    const previewContent = prettifyJson(sourceContent);
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          rightContent={
            <ViewModeToggle
              viewMode={viewMode}
              onChange={(mode) => {
                if (isEditing) stopEditing();
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={viewMode === "preview" ? previewContent : sourceContent}
            downloadContent={sourceContent}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly && viewMode === "source"}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {viewMode === "preview" ? (
            <SourcePre content={previewContent} readOnly whiteSpace="pre" />
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

  // Plain text — source only, consistent header
  if (isText) {
    return (
      <div className="flex h-full flex-col">
        <FileHeader name={name} mimeType={mimeType} size={data.size} />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={isEditing ? editableContent : (data.content ?? "")}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {isEditing ? (
            <FileTextarea
              value={editableContent}
              onChange={(v) =>
                setEditOverride({ path: selectedPath, content: v })
              }
              onSave={handleSave}
            />
          ) : (
            <SourcePre
              content={data.content ?? ""}
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
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
    return (
      <div className="flex h-full flex-col">
        <FileHeader name={name} mimeType={mimeType} size={data.size} />
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

  // Binary fallback — metadata card
  return (
    <div className="flex h-full flex-col">
      <FileHeader name={name} mimeType={mimeType} size={data.size} />
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
              {formatFileSize(data.size, "Unknown size")}
            </p>
            {data.modifiedAt && (
              <p
                className="text-body-small-default"
                style={{
                  color: "var(--content-secondary, var(--content-tertiary))",
                }}
              >
                Modified: {new Date(data.modifiedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
