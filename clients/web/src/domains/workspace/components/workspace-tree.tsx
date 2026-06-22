/**
 * File tree sidebar for the workspace browser. Fetches the assistant's
 * workspace directory listing, renders a recursive expandable tree, and
 * provides search filtering plus file/folder creation. Each row carries a
 * context menu (right-click / long-press) with New File / New Folder (on
 * directories), Delete, and Rename — mirroring the original native macOS
 * app's workspace panel.
 */

import {
    queryOptions,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import {
    ArrowDownAZ,
    ArrowDownWideNarrow,
    ChevronDown,
    ChevronRight,
    Eye,
    EyeOff,
    FilePlus,
    FileText,
    Folder,
    FolderPlus,
    Image as ImageIcon,
    Pencil,
    Plus,
    Search,
    Trash2,
    Video,
    X,
} from "lucide-react";
import {
    type FormEvent,
    useCallback,
    useMemo,
    useRef,
    useState,
} from "react";

import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import { isHiddenPath } from "@/domains/workspace/utils/is-hidden-path";
import {
    sortEntries,
    type WorkspaceSortMode,
} from "@/domains/workspace/utils/sort-entries";
import {
    workspaceDeletePost,
    workspaceMkdirPost,
    workspaceRenamePost,
    workspaceTreeGet,
    workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@vellumai/design-library/components/bottom-sheet";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { ContextMenu } from "@vellumai/design-library/components/context-menu";
import { Input } from "@vellumai/design-library/components/input";
import { Menu } from "@vellumai/design-library/components/menu";
import { Modal } from "@vellumai/design-library/components/modal";
import { PanelItem } from "@vellumai/design-library/components/panel-item";

export type { WorkspaceSortMode };

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type WorkspaceTreeEntry = WorkspaceTreeGetResponse["entries"][number];

interface EntryTarget {
  path: string;
  name: string;
  isDirectory: boolean;
}

type TreeDialog =
  | { type: "create"; kind: "file" | "folder"; parentPath: string }
  | { type: "rename"; path: string; name: string };

function workspaceTreeRetrieveOptions(opts: {
  path: { assistant_id: string };
  query?: { path?: string; showHidden?: boolean; includeDirSizes?: boolean };
}) {
  return queryOptions<WorkspaceTreeGetResponse>({
    queryFn: async () => {
      const query: Record<string, string> = {};
      if (opts.query?.path) query.path = opts.query.path;
      if (opts.query?.showHidden) query.showHidden = "true";
      if (opts.query?.includeDirSizes) query.includeDirSizes = "true";
      const { data, error } = await workspaceTreeGet({
        path: opts.path,
        query,
      });
      if (error) {
        throw error;
      }
      if (!data) {
        throw new Error("Failed to load workspace tree");
      }
      return data;
    },
    queryKey: ["assistantsWorkspaceTreeRetrieve", opts],
  });
}

/**
 * The daemon's write and rename endpoints overwrite existing entries
 * unconditionally, so creating or renaming onto an existing sibling would
 * silently destroy it. Names compare case-insensitively because the default
 * macOS/iOS filesystems treat Foo.md and foo.md as the same file. Renames
 * pass `excludeName` (the entry's current name) so a case-only rename of
 * the same file is still allowed.
 */
async function assertNameAvailable(
  assistantId: string,
  parentPath: string,
  name: string,
  excludeName?: string,
) {
  const target = name.toLowerCase();
  const excluded = excludeName?.toLowerCase();
  const { data } = await workspaceTreeGet({
    path: { assistant_id: assistantId },
    query: parentPath ? { path: parentPath } : {},
  });
  const conflict = data?.entries?.some((entry) => {
    const existing = (entry.name ?? "").toLowerCase();
    return existing === target && existing !== excluded;
  });
  if (conflict) {
    throw new Error(`"${name}" already exists here.`);
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileIconForEntry({ entry }: { entry: WorkspaceTreeEntry }) {
  if (entry.type === "directory") {
    return (
      <Folder
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--content-tertiary)" }}
      />
    );
  }
  if (entry.mimeType?.startsWith("image/")) {
    return (
      <ImageIcon
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--content-tertiary)" }}
      />
    );
  }
  if (entry.mimeType?.startsWith("video/")) {
    return (
      <Video
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--content-tertiary)" }}
      />
    );
  }
  return (
    <FileText
      className="h-4 w-4 shrink-0"
      style={{ color: "var(--content-tertiary)" }}
    />
  );
}

function TreeNode({
  entry,
  assistantId,
  expandedPaths,
  selectedPath,
  showHidden,
  sortMode,
  searchLower,
  onToggleExpand,
  onSelectPath,
  onRequestDelete,
  onRequestRename,
  onRequestCreate,
  depth,
}: {
  entry: WorkspaceTreeEntry;
  assistantId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  showHidden: boolean;
  sortMode: WorkspaceSortMode;
  searchLower: string;
  onToggleExpand: (path: string) => void;
  onSelectPath: (path: string) => void;
  onRequestDelete: (target: EntryTarget) => void;
  onRequestRename: (target: EntryTarget) => void;
  onRequestCreate: (input: {
    kind: "file" | "folder";
    parentPath: string;
  }) => void;
  depth: number;
}) {
  const entryPath = entry.path ?? "";
  const entryName = entry.name ?? "";
  const isDirectory = entry.type === "directory";
  const isExpanded = expandedPaths.has(entryPath);
  const isSelected = selectedPath === entryPath;
  const isHidden = entryName.startsWith(".");
  // The daemon rejects writes, renames, and deletes on paths with hidden
  // segments, so don't offer the context menu for them.
  const hasMenu = !isHiddenPath(entryPath);

  // Expand directories whose names match during search so their children are visible.
  const effectivelyExpanded =
    isDirectory && (isExpanded || searchLower.length > 0);

  const { data } = useQuery({
    ...workspaceTreeRetrieveOptions({
      path: { assistant_id: assistantId },
      query: {
        path: entryPath,
        showHidden,
        includeDirSizes: sortMode === "size",
      },
    }),
    enabled: isDirectory && effectivelyExpanded,
  });

  const children = useMemo(
    () => sortEntries(data?.entries ?? [], sortMode),
    [data?.entries, sortMode],
  );
  const nameMatches =
    searchLower === "" || entryName.toLowerCase().includes(searchLower);

  // Filter files by name match. Directories stay visible during search so
  // their children can mount, fetch, and reveal deeply nested matches.
  if (searchLower !== "" && !isDirectory && !nameMatches) {
    return null;
  }

  const handleClick = () => {
    if (isDirectory) {
      onToggleExpand(entryPath);
    } else {
      onSelectPath(entryPath);
    }
  };

  const row = (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
      style={{
        paddingLeft: `${depth * 14 + 8}px`,
        paddingRight: "8px",
        color: isSelected
          ? "var(--content-default)"
          : isHidden
            ? "var(--content-tertiary)"
            : "var(--content-default)",
        backgroundColor: isSelected
          ? "color-mix(in oklab, var(--primary-base) 12%, transparent)"
          : undefined,
        opacity: isHidden && !isSelected ? 0.7 : 1,
      }}
    >
      {isDirectory ? (
        effectivelyExpanded ? (
          <ChevronDown
            className="h-3 w-3 shrink-0"
            style={{ color: "var(--content-tertiary)" }}
          />
        ) : (
          <ChevronRight
            className="h-3 w-3 shrink-0"
            style={{ color: "var(--content-tertiary)" }}
          />
        )
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <FileIconForEntry entry={entry} />
      <span className="min-w-0 flex-1 truncate">{entryName}</span>
      {entry.size != null && (
        <span
          className="shrink-0 text-label-medium-default tabular-nums"
          style={{ color: "var(--content-tertiary)" }}
        >
          {formatFileSize(entry.size)}
        </span>
      )}
    </button>
  );

  return (
    <div>
      {hasMenu ? (
        <ContextMenu.Root>
          <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
          <ContextMenu.Content>
            {isDirectory && (
              <>
                <ContextMenu.Item
                  leftIcon={<FilePlus className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    onRequestCreate({ kind: "file", parentPath: entryPath })
                  }
                >
                  New File
                </ContextMenu.Item>
                <ContextMenu.Item
                  leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    onRequestCreate({ kind: "folder", parentPath: entryPath })
                  }
                >
                  New Folder
                </ContextMenu.Item>
                <ContextMenu.Separator />
              </>
            )}
            <ContextMenu.Item
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onSelect={() =>
                onRequestDelete({ path: entryPath, name: entryName, isDirectory })
              }
            >
              Delete
            </ContextMenu.Item>
            <ContextMenu.Item
              leftIcon={<Pencil className="h-3.5 w-3.5" />}
              onSelect={() =>
                onRequestRename({ path: entryPath, name: entryName, isDirectory })
              }
            >
              Rename
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      ) : (
        row
      )}
      {isDirectory && effectivelyExpanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              assistantId={assistantId}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              showHidden={showHidden}
              sortMode={sortMode}
              searchLower={searchLower}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
              onRequestDelete={onRequestDelete}
              onRequestRename={onRequestRename}
              onRequestCreate={onRequestCreate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Name dialog (create / rename)
// ---------------------------------------------------------------------------

interface NameItemDialogProps {
  title: string;
  placeholder: string;
  confirmLabel: string;
  pendingLabel: string;
  initialName?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
  pending: boolean;
  error: string | null;
}

function NameItemDialog({
  title,
  placeholder,
  confirmLabel,
  pendingLabel,
  initialName,
  onCancel,
  onConfirm,
  pending,
  error,
}: NameItemDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName ?? "");

  const trimmed = name.trim();
  // Single path segment only — a name like "sub/existing.md" or "../x" would
  // land outside the parent directory and bypass the sibling conflict check.
  const invalidName =
    trimmed.length > 0 &&
    (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..");
  const canSubmit = trimmed.length > 0 && !invalidName && !pending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) onConfirm(trimmed);
  };

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        aria-describedby={undefined}
        // Select-all on open so typing replaces a pre-filled name in one
        // motion; the selection is deferred a frame because iOS Safari
        // ignores selection APIs called synchronously during focus.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (input) {
            input.focus();
            requestAnimationFrame(() => {
              input.setSelectionRange(0, input.value.length);
            });
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!pending) onCancel();
        }}
      >
        <form onSubmit={handleSubmit}>
          <Modal.Header>
            <Modal.Title>{title}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Input
              ref={inputRef}
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholder}
              errorText={
                error ??
                (invalidName
                  ? "Enter a single file or folder name without slashes."
                  : undefined)
              }
              autoComplete="off"
              spellCheck={false}
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="button"
              variant="outlined"
              onClick={onCancel}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// Main tree export
// ---------------------------------------------------------------------------

export function WorkspaceTree({
  assistantId,
  expandedPaths,
  selectedPath,
  showHidden,
  sortMode,
  onToggleExpand,
  onExpandPath,
  onSelectPath,
  onToggleShowHidden,
  onChangeSortMode,
  onPathDeleted,
  onPathRenamed,
}: {
  assistantId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  showHidden: boolean;
  sortMode: WorkspaceSortMode;
  onToggleExpand: (path: string) => void;
  onExpandPath: (path: string) => void;
  onSelectPath: (path: string) => void;
  onToggleShowHidden: () => void;
  onChangeSortMode: (next: WorkspaceSortMode) => void;
  onPathDeleted: (path: string) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();

  const [menuOpen, setMenuOpen] = useState(false);

  const [dialog, setDialog] = useState<TreeDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
  }, []);

  const { data, isLoading } = useQuery(
    workspaceTreeRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { showHidden, includeDirSizes: sortMode === "size" },
    }),
  );

  const rootEntries = useMemo(
    () => sortEntries(data?.entries ?? [], sortMode),
    [data?.entries, sortMode],
  );

  // Invalidate the file metadata/content caches too: deleting or renaming
  // foo.md and then recreating it must not serve the old file's cached
  // contents from the viewer.
  const invalidateWorkspace = useCallback(() => {
    for (const key of [
      "assistantsWorkspaceTreeRetrieve",
      "assistantsWorkspaceFileRetrieve",
      "assistantsWorkspaceFileContentRetrieve",
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: {
      kind: "file" | "folder";
      parentPath: string;
      name: string;
    }) => {
      const path = input.parentPath
        ? `${input.parentPath}/${input.name}`
        : input.name;
      await assertNameAvailable(assistantId, input.parentPath, input.name);
      const { error, response } =
        input.kind === "file"
          ? await workspaceWritePost({
              path: { assistant_id: assistantId },
              body: { path, content: "", encoding: "utf8" },
              throwOnError: false,
            })
          : await workspaceMkdirPost({
              path: { assistant_id: assistantId },
              body: { path },
              throwOnError: false,
            });
      if (error || !response?.ok) {
        throw new Error(
          typeof error === "string"
            ? error
            : "Failed to create — check the name and try again.",
        );
      }
      return { ...input, path };
    },
    onSuccess: (input) => {
      closeDialog();
      invalidateWorkspace();
      if (input.parentPath) {
        onExpandPath(input.parentPath);
      }
      if (input.kind === "file") {
        onSelectPath(input.path);
      } else {
        onExpandPath(input.path);
      }
    },
    onError: (err: unknown) => {
      setDialogError(err instanceof Error ? err.message : "Failed to create.");
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { oldPath: string; newName: string }) => {
      const slash = input.oldPath.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : input.oldPath.slice(0, slash);
      const oldName = input.oldPath.slice(slash + 1);
      const newPath = parentPath
        ? `${parentPath}/${input.newName}`
        : input.newName;
      await assertNameAvailable(assistantId, parentPath, input.newName, oldName);
      const { error, response } = await workspaceRenamePost({
        path: { assistant_id: assistantId },
        body: { oldPath: input.oldPath, newPath },
        throwOnError: false,
      });
      if (error || !response?.ok) {
        throw new Error(
          typeof error === "string"
            ? error
            : "Failed to rename — check the name and try again.",
        );
      }
      return { oldPath: input.oldPath, newPath };
    },
    onSuccess: ({ oldPath, newPath }) => {
      closeDialog();
      invalidateWorkspace();
      onPathRenamed(oldPath, newPath);
    },
    onError: (err: unknown) => {
      setDialogError(err instanceof Error ? err.message : "Failed to rename.");
    },
  });

  const handleRequestCreate = useCallback(
    (input: { kind: "file" | "folder"; parentPath: string }) => {
      setDialogError(null);
      setDialog({ type: "create", ...input });
    },
    [],
  );

  const handleRequestRename = useCallback((target: EntryTarget) => {
    setDialogError(null);
    setDialog({ type: "rename", path: target.path, name: target.name });
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<EntryTarget | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (target: EntryTarget) => {
      const { error, response } = await workspaceDeletePost({
        path: { assistant_id: assistantId },
        body: { path: target.path },
        throwOnError: false,
      });
      if (error || !response?.ok) {
        throw new Error(
          typeof error === "string" ? error : "Failed to delete — try again.",
        );
      }
      return target;
    },
    onSuccess: (target) => {
      setDeleteTarget(null);
      invalidateWorkspace();
      onPathDeleted(target.path);
    },
  });

  const handleRequestDelete = useCallback(
    (target: EntryTarget) => {
      deleteMutation.reset();
      setDeleteTarget(target);
    },
    [deleteMutation],
  );

  return (
    <>
      <div
        className="flex items-center justify-between border-b px-3 py-2.5"
        style={{ borderColor: "var(--border-element)" }}
      >
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-secondary)" }}
        >
          Files
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            iconOnly={
              sortMode === "size" ? (
                <ArrowDownWideNarrow aria-hidden />
              ) : (
                <ArrowDownAZ aria-hidden />
              )
            }
            onClick={() =>
              onChangeSortMode(sortMode === "size" ? "name" : "size")
            }
            aria-label={sortMode === "size" ? "Sort by name" : "Sort by size"}
            title={
              sortMode === "size"
                ? "Sorted by size — switch to name"
                : "Sorted by name — switch to size"
            }
            tintColor={
              sortMode === "size"
                ? "var(--content-default)"
                : "var(--content-tertiary)"
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="compact"
            iconOnly={showHidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
            onClick={onToggleShowHidden}
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            tintColor={
              showHidden ? "var(--content-default)" : "var(--content-tertiary)"
            }
          />
          <WorkspaceTreeCreateMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onSelectKind={(kind) => {
              setMenuOpen(false);
              handleRequestCreate({ kind, parentPath: "" });
            }}
          />
        </div>
      </div>

      <div className="px-3 py-2">
        <div className="relative">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files"
            leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              iconOnly={<X aria-hidden />}
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              tintColor="var(--content-tertiary)"
            />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              style={{ color: "var(--content-tertiary)" }}
            />
          </div>
        ) : !rootEntries.length ? (
          <p
            className="px-3 py-4 text-center text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            No files found
          </p>
        ) : (
          rootEntries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              assistantId={assistantId}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              showHidden={showHidden}
              sortMode={sortMode}
              searchLower={searchLower}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
              onRequestDelete={handleRequestDelete}
              onRequestRename={handleRequestRename}
              onRequestCreate={handleRequestCreate}
              depth={0}
            />
          ))
        )}
      </div>

      {dialog?.type === "create" && (
        <NameItemDialog
          key={`create-${dialog.kind}-${dialog.parentPath}`}
          title={dialog.kind === "file" ? "New File" : "New Folder"}
          placeholder={dialog.kind === "file" ? "filename.md" : "folder-name"}
          confirmLabel="Create"
          pendingLabel="Creating…"
          onCancel={closeDialog}
          onConfirm={(name) => {
            setDialogError(null);
            createMutation.mutate({
              kind: dialog.kind,
              parentPath: dialog.parentPath,
              name,
            });
          }}
          pending={createMutation.isPending}
          error={dialogError}
        />
      )}

      {dialog?.type === "rename" && (
        <NameItemDialog
          key={`rename-${dialog.path}`}
          title="Rename"
          placeholder={dialog.name}
          confirmLabel="Rename"
          pendingLabel="Renaming…"
          initialName={dialog.name}
          onCancel={closeDialog}
          onConfirm={(name) => {
            if (name === dialog.name) {
              closeDialog();
              return;
            }
            setDialogError(null);
            renameMutation.mutate({ oldPath: dialog.path, newName: name });
          }}
          pending={renameMutation.isPending}
          error={dialogError}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget?.isDirectory ? "Delete Folder" : "Delete File"}
        message={
          <>
            Are you sure you want to delete{" "}
            <span style={{ color: "var(--content-default)" }}>
              {deleteTarget?.name}
            </span>
            {deleteTarget?.isDirectory ? " and all of its contents" : ""}? This
            cannot be undone.
            {deleteMutation.error && (
              <span
                className="mt-2 block"
                style={{ color: "var(--system-negative-strong)" }}
              >
                {deleteMutation.error.message}
              </span>
            )}
          </>
        }
        confirmLabel={deleteMutation.isPending ? "Deleting…" : "Delete"}
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceTreeCreateMenu — desktop popover / mobile bottom-sheet
// ---------------------------------------------------------------------------

export interface WorkspaceTreeCreateMenuProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSelectKind: (kind: "file" | "folder") => void;
}

export function WorkspaceTreeCreateMenu({
  open,
  onOpenChange,
  onSelectKind,
}: WorkspaceTreeCreateMenuProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            iconOnly={<Plus aria-hidden />}
            aria-label="Create new file or folder"
            title="New file or folder"
            tintColor="var(--content-tertiary)"
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Create new</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            <PanelItem
              icon={FilePlus}
              label="New File"
              onSelect={() => onSelectKind("file")}
            />
            <PanelItem
              icon={FolderPlus}
              label="New Folder"
              onSelect={() => onSelectKind("folder")}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          iconOnly={<Plus aria-hidden />}
          aria-label="Create new file or folder"
          title="New file or folder"
          tintColor="var(--content-tertiary)"
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={<FilePlus className="h-3.5 w-3.5" />}
          onSelect={() => onSelectKind("file")}
        >
          New File
        </Menu.Item>
        <Menu.Item
          leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
          onSelect={() => onSelectKind("folder")}
        >
          New Folder
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
