/**
 * File tree sidebar for the workspace browser. Fetches the assistant's
 * workspace directory listing, renders a recursive expandable tree, and
 * provides search filtering plus file/folder creation. Each row carries a
 * context menu (right-click / long-press) with New File / New Folder (on
 * directories), Delete, and Rename — mirroring the original native macOS
 * app's workspace panel.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Trans, useTranslation } from "@/i18n";
import {
  type EntryTarget,
  WorkspaceTreeRow,
} from "@/domains/workspace/components/workspace-tree-row";
import { useWorkspaceTreeListings } from "@/domains/workspace/use-workspace-tree-listings";
import {
  buildWorkspaceTreeRows,
  WORKSPACE_ROOT_PATH,
} from "@/domains/workspace/utils/build-workspace-tree-rows";
import { type WorkspaceSortMode } from "@/domains/workspace/utils/sort-entries";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  WorkspaceNameTakenError,
  workspaceMutationErrorMessage,
} from "@/domains/workspace/utils/workspace-mutation-error";
import {
  workspaceDeletePost,
  workspaceMkdirPost,
  workspaceRenamePost,
  workspaceTreeGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { WORKSPACE_TREE_QUERY_KEY } from "@/lib/workspace-tree-query";
import { toApiError } from "@/utils/api-errors";
import {
  workspaceBasenameOf,
  workspaceDirOf,
} from "@/utils/workspace-path-links";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { BottomSheet } from "@vellumai/design-library/components/bottom-sheet";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { Menu } from "@vellumai/design-library/components/menu";
import { Modal } from "@vellumai/design-library/components/modal";
import { PanelItem } from "@vellumai/design-library/components/panel-item";

export type { WorkspaceSortMode };

// Filtering waits for typing to pause so each keystroke does not rebuild the
// row list; search reads loaded listings and issues no requests either way.
const SEARCH_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type TreeDialog =
  | { type: "create"; kind: "file" | "folder"; parentPath: string }
  | { type: "rename"; path: string; name: string };

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
    const existing = entry.name.toLowerCase();
    return existing === target && existing !== excluded;
  });
  if (conflict) {
    throw new WorkspaceNameTakenError(name);
  }
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
  const { t } = useTranslation("workspace");
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
    if (canSubmit) {
      onConfirm(trimmed);
    }
  };

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next && !pending) {
          onCancel();
        }
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
          if (!pending) {
            onCancel();
          }
        }}
      >
        <form onSubmit={handleSubmit}>
          <Modal.Header>
            <Modal.Title>{title}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Input
              ref={inputRef}
              label={t("workspaceTree.nameLabel")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholder}
              errorText={
                error ??
                (invalidName ? t("workspaceTree.nameError") : undefined)
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
              {t("workspaceTree.cancel")}
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
  search,
  onSearchChange,
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
  /**
   * The name filter, owned by `WorkspaceBrowser` alongside the expansion and
   * selection it already keeps there. This tree renders in two surfaces that
   * substitute for each other, and switching between them remounts it, so
   * state held here would be dropped when the pane crosses the threshold.
   */
  search: string;
  onSearchChange: (search: string) => void;
}) {
  const { t } = useTranslation("workspace");
  const queryClient = useQueryClient();

  const [menuOpen, setMenuOpen] = useState(false);

  const [dialog, setDialog] = useState<TreeDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
  }, []);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  // Messaging follows the same query the rows do, so a note never describes
  // results that have not been filtered yet.
  const isSearching = debouncedSearch.trim() !== "";
  const searchScopeId = useId();

  const { listings, isRootLoading, searchScope, isSearchIncomplete } =
    useWorkspaceTreeListings({
      assistantId,
      expandedPaths,
      showHidden,
      sortMode,
    });
  const searchNote = !isSearching
    ? null
    : searchScope === "open-folders"
      ? t("workspaceTree.searchScope")
      : isSearchIncomplete
        ? t("workspaceTree.searchIncomplete")
        : null;
  const hasRootEntries = (listings.get(WORKSPACE_ROOT_PATH)?.length ?? 0) > 0;

  const rows = useMemo(
    () =>
      buildWorkspaceTreeRows({
        listings,
        expandedPaths,
        sortMode,
        query: debouncedSearch,
      }),
    [listings, expandedPaths, sortMode, debouncedSearch],
  );

  // Invalidate the file metadata/content caches too: deleting or renaming
  // foo.md and then recreating it must not serve the old file's cached
  // contents from the viewer.
  const invalidateWorkspace = useCallback(() => {
    for (const key of [
      WORKSPACE_TREE_QUERY_KEY,
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
        throw response ? toApiError(error, response) : error;
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
      setDialogError(workspaceMutationErrorMessage(err, "create", t));
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { oldPath: string; newName: string }) => {
      const parentPath = workspaceDirOf(input.oldPath);
      const oldName = workspaceBasenameOf(input.oldPath);
      const newPath = parentPath
        ? `${parentPath}/${input.newName}`
        : input.newName;
      await assertNameAvailable(
        assistantId,
        parentPath,
        input.newName,
        oldName,
      );
      const { error, response } = await workspaceRenamePost({
        path: { assistant_id: assistantId },
        body: { oldPath: input.oldPath, newPath },
        throwOnError: false,
      });
      if (error || !response?.ok) {
        throw response ? toApiError(error, response) : error;
      }
      return { oldPath: input.oldPath, newPath };
    },
    onSuccess: ({ oldPath, newPath }) => {
      closeDialog();
      invalidateWorkspace();
      onPathRenamed(oldPath, newPath);
    },
    onError: (err: unknown) => {
      setDialogError(workspaceMutationErrorMessage(err, "rename", t));
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
        throw response ? toApiError(error, response) : error;
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
          {t("workspaceTree.heading")}
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
            aria-label={
              sortMode === "size"
                ? t("workspaceTree.sortByNameAria")
                : t("workspaceTree.sortBySizeAria")
            }
            title={
              sortMode === "size"
                ? t("workspaceTree.sortedBySizeTitle")
                : t("workspaceTree.sortedByNameTitle")
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
            aria-label={
              showHidden
                ? t("workspaceTree.hideHiddenAria")
                : t("workspaceTree.showHiddenAria")
            }
            title={
              showHidden
                ? t("workspaceTree.hideHiddenAria")
                : t("workspaceTree.showHiddenAria")
            }
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
        {/* The clear button centers on this wrapper, so the scope note sits
            outside it rather than in the input's own helper slot. */}
        <div className="relative">
          <Input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("workspaceTree.searchPlaceholder")}
            leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
            aria-describedby={searchNote ? searchScopeId : undefined}
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
              onClick={() => onSearchChange("")}
              aria-label={t("workspaceTree.clearSearchAria")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              tintColor="var(--content-tertiary)"
            />
          )}
        </div>
        {searchNote && (
          <span
            id={searchScopeId}
            className="mt-1 block text-body-small-default text-[var(--content-tertiary)]"
          >
            {searchNote}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {isRootLoading ? (
          <div className="flex items-center justify-center py-8">
            <div
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              style={{ color: "var(--content-tertiary)" }}
            />
          </div>
        ) : !hasRootEntries || rows.length === 0 ? (
          <p
            className="px-3 py-4 text-center text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {!hasRootEntries
              ? t("workspaceTree.noFilesFound")
              : searchScope === "workspace"
                ? t("workspaceTree.noMatches")
                : t("workspaceTree.noSearchMatches")}
          </p>
        ) : (
          rows.map((row) => (
            <WorkspaceTreeRow
              key={row.entry.path}
              entry={row.entry}
              depth={row.depth}
              isExpanded={row.isExpanded}
              isSelected={selectedPath === row.entry.path}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
              onRequestDelete={handleRequestDelete}
              onRequestRename={handleRequestRename}
              onRequestCreate={handleRequestCreate}
            />
          ))
        )}
      </div>

      {dialog?.type === "create" && (
        <NameItemDialog
          key={`create-${dialog.kind}-${dialog.parentPath}`}
          title={
            dialog.kind === "file"
              ? t("workspaceTree.newFile")
              : t("workspaceTree.newFolder")
          }
          placeholder={dialog.kind === "file" ? "filename.md" : "folder-name"}
          confirmLabel={t("workspaceTree.create")}
          pendingLabel={t("workspaceTree.creating")}
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
          title={t("workspaceTree.rename")}
          placeholder={dialog.name}
          confirmLabel={t("workspaceTree.rename")}
          pendingLabel={t("workspaceTree.renaming")}
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
        title={
          deleteTarget?.isDirectory
            ? t("workspaceTree.deleteFolderTitle")
            : t("workspaceTree.deleteFileTitle")
        }
        message={
          <>
            <Trans
              i18nKey={
                deleteTarget?.isDirectory
                  ? "workspaceTree.deleteFolderMessage"
                  : "workspaceTree.deleteFileMessage"
              }
              ns="workspace"
              values={{ name: deleteTarget?.name ?? "" }}
              components={{
                name: <span style={{ color: "var(--content-default)" }} />,
              }}
            />
            {deleteMutation.error && (
              <span
                className="mt-2 block"
                style={{ color: "var(--system-negative-strong)" }}
              >
                {workspaceMutationErrorMessage(
                  deleteMutation.error,
                  "delete",
                  t,
                )}
              </span>
            )}
          </>
        }
        confirmLabel={
          deleteMutation.isPending
            ? t("workspaceTree.deleting")
            : t("workspaceTree.delete")
        }
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate(deleteTarget);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceTreeCreateMenu: anchored popover / touch bottom-sheet
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
  const { t } = useTranslation("workspace");
  const isTouchMobile = useTouchMobile();

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            iconOnly={<Plus aria-hidden />}
            aria-label={t("workspaceTree.createTriggerAria")}
            title={t("workspaceTree.createTriggerTitle")}
            tintColor="var(--content-tertiary)"
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>
              {t("workspaceTree.creatingHeading")}
            </BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            <PanelItem
              icon={FilePlus}
              label={t("workspaceTree.newFile")}
              onSelect={() => onSelectKind("file")}
            />
            <PanelItem
              icon={FolderPlus}
              label={t("workspaceTree.newFolder")}
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
          aria-label={t("workspaceTree.createTriggerAria")}
          title={t("workspaceTree.createTriggerTitle")}
          tintColor="var(--content-tertiary)"
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={<FilePlus className="h-3.5 w-3.5" />}
          onSelect={() => onSelectKind("file")}
        >
          {t("workspaceTree.newFile")}
        </Menu.Item>
        <Menu.Item
          leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
          onSelect={() => onSelectKind("folder")}
        >
          {t("workspaceTree.newFolder")}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
