
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  FileIcon,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceViewMode } from "@/components/app/intelligence/WorkspaceBrowser.js";
import { Button } from "@vellum/design-library/components/button";
import { client } from "@/generated/api/client.gen.js";
import { isJson, prettifyJson } from "@/lib/json/file-json.js";
import { FileMarkdown, isMarkdown } from "@/lib/markdown/file-markdown.js";

interface WorkspaceFileResponse {
  name?: string;
  path?: string;
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
  content?: string;
}

function workspaceFileRetrieveOptions(opts: {
  path: { assistant_id: string };
  query: { path: string };
}) {
  return queryOptions<WorkspaceFileResponse>({
    queryFn: async () => {
      const { data, error } = await client.get<WorkspaceFileResponse, unknown>({
        url: "/v1/assistants/{assistant_id}/workspace/file/",
        path: opts.path,
        query: opts.query,
      });
      if (error) throw error;
      return data!;
    },
    queryKey: ["assistantsWorkspaceFileRetrieve", opts],
  });
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes == null) return "Unknown size";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


function FileHeaderIcon({
  mimeType,
}: {
  mimeType: string;
}) {
  // Servers commonly suffix the mime with parameters such as `;charset=utf-8`,
  // so strict equality against bare types would mis-classify them.
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
        backgroundColor: "color-mix(in oklab, var(--content-default) 10%, transparent)",
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
        backgroundColor: "color-mix(in oklab, var(--content-default) 6%, transparent)",
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
              backgroundColor: active
                ? "var(--surface-lift)"
                : "transparent",
              color: active
                ? "var(--content-default)"
                : "var(--content-tertiary)",
              boxShadow: active
                ? "0 1px 2px rgba(0,0,0,0.15)"
                : undefined,
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
  rightContent?: React.ReactNode;
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
}: {
  assistantId: string;
  path: string;
  mimeType: string;
}) {
  const { data: blob, isLoading } = useQuery({
    queryFn: async () => {
      const res = await client.get<Blob, unknown>({
        url: "/v1/assistants/{assistant_id}/workspace/file/content/",
        path: { assistant_id: assistantId },
        query: { path },
        parseAs: "blob",
      });
      if (res.error) throw res.error;
      return res.data!;
    },
    queryKey: ["assistantsWorkspaceFileContentRetrieve", { assistantId, path }],
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

function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
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
  showEdit,
  isEditing,
  onToggleEdit,
}: {
  content: string;
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
    </div>
  );
}

export function WorkspaceFileViewer({
  assistantId,
  selectedPath,
  viewMode,
  onChangeViewMode,
  onBrowse,
}: {
  assistantId: string;
  selectedPath: string | null;
  viewMode: WorkspaceViewMode;
  onChangeViewMode: (mode: WorkspaceViewMode) => void;
  onBrowse?: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    ...workspaceFileRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { path: selectedPath ?? "" },
    }),
    enabled: !!selectedPath,
  });

  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editOverride, setEditOverride] = useState<{
    path: string;
    content: string;
  } | null>(null);

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
    mutationFn: async ({ path, content }: { path: string; content: string }) => {
      const { error, response } = await client.post<unknown, unknown>({
        url: "/v1/assistants/{assistant_id}/workspace/write/",
        path: { assistant_id: assistantId },
        body: { path, content, encoding: "utf8" },
        headers: { "Content-Type": "application/json" },
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

  const mimeType = data.mimeType ?? "application/octet-stream";
  const name = data.name ?? selectedPath.split("/").pop() ?? selectedPath;
  const markdown = isMarkdown(name, mimeType);
  const json = isJson(name, mimeType);
  // JSON files are handled by the dedicated `json` branch below; here `isText`
  // only needs to catch plain `text/*` files. `mimeType.startsWith("text/")`
  // already tolerates parameters like `;charset=utf-8`.
  const isText = mimeType.startsWith("text/") && data.content != null;
  const readOnly = selectedPath ? isHiddenPath(selectedPath) : true;
  const isDirty = editableContent !== originalContent;

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
                if (isEditing) {
                  stopEditing();
                }
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={sourceContent}
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
            <textarea
              className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
              }}
              value={editableContent}
              onChange={(e) =>
                setEditOverride({ path: selectedPath, content: e.target.value })
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (isDirty && selectedPath && !saveMutation.isPending) {
                    saveMutation.mutate({ path: selectedPath, content: editableContent });
                  }
                }
              }}
              spellCheck={false}
            />
          ) : (
            <pre
              className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
                whiteSpace: "pre-wrap",
              }}
              onClick={
                !readOnly
                  ? () => setEditingPath(selectedPath)
                  : undefined
              }
            >
              {data.content}
            </pre>
          )}
        </div>
        {isEditing && (
          <EditFooter
            isDirty={isDirty}
            isSaving={saveMutation.isPending}
            onSave={() => {
              if (selectedPath) {
                saveMutation.mutate({ path: selectedPath, content: editableContent });
              }
            }}
            onDiscard={stopEditing}
          />
        )}
      </div>
    );
  }

  // JSON: Preview (pretty-printed) / Source (raw) toggle, mirroring markdown.
  // `prettifyJson` falls back to the raw content when parsing fails, so
  // partial saves and hand-edited files still render rather than disappearing.
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
                if (isEditing) {
                  stopEditing();
                }
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={viewMode === "preview" ? previewContent : sourceContent}
            showEdit={!readOnly && viewMode === "source"}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {viewMode === "preview" ? (
            <pre
              className="m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed"
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
                // Preserve JSON's structural indentation — `pre-wrap` would
                // wrap long string values and visually break the indent grid.
                whiteSpace: "pre",
              }}
            >
              {previewContent}
            </pre>
          ) : isEditing ? (
            <textarea
              className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
              }}
              value={editableContent}
              onChange={(e) =>
                setEditOverride({ path: selectedPath, content: e.target.value })
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (isDirty && selectedPath && !saveMutation.isPending) {
                    saveMutation.mutate({ path: selectedPath, content: editableContent });
                  }
                }
              }}
              spellCheck={false}
            />
          ) : (
            <pre
              className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
                whiteSpace: "pre-wrap",
              }}
              onClick={
                !readOnly
                  ? () => setEditingPath(selectedPath)
                  : undefined
              }
            >
              {data.content}
            </pre>
          )}
        </div>
        {isEditing && (
          <EditFooter
            isDirty={isDirty}
            isSaving={saveMutation.isPending}
            onSave={() => {
              if (selectedPath) {
                saveMutation.mutate({ path: selectedPath, content: editableContent });
              }
            }}
            onDiscard={stopEditing}
          />
        )}
      </div>
    );
  }

  // Plain text — source only, but consistent header
  if (isText) {
    return (
      <div className="flex h-full flex-col">
        <FileHeader name={name} mimeType={mimeType} size={data.size} />
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={isEditing ? editableContent : (data.content ?? "")}
            showEdit={!readOnly}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {isEditing ? (
            <textarea
              className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
              }}
              value={editableContent}
              onChange={(e) =>
                setEditOverride({ path: selectedPath, content: e.target.value })
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (isDirty && selectedPath && !saveMutation.isPending) {
                    saveMutation.mutate({ path: selectedPath, content: editableContent });
                  }
                }
              }}
              spellCheck={false}
            />
          ) : (
            <pre
              className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
              style={{
                color: "var(--content-default)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
                whiteSpace: "pre-wrap",
              }}
              onClick={
                !readOnly
                  ? () => setEditingPath(selectedPath)
                  : undefined
              }
            >
              {data.content}
            </pre>
          )}
        </div>
        {isEditing && (
          <EditFooter
            isDirty={isDirty}
            isSaving={saveMutation.isPending}
            onSave={() => {
              if (selectedPath) {
                saveMutation.mutate({ path: selectedPath, content: editableContent });
              }
            }}
            onDiscard={stopEditing}
          />
        )}
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
              style={{ color: "var(--content-secondary, var(--content-tertiary))" }}
            >
              {mimeType}
            </p>
            <p
              className="text-body-small-default"
              style={{ color: "var(--content-secondary, var(--content-tertiary))" }}
            >
              {formatFileSize(data.size)}
            </p>
            {data.modifiedAt && (
              <p
                className="text-body-small-default"
                style={{ color: "var(--content-secondary, var(--content-tertiary))" }}
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
