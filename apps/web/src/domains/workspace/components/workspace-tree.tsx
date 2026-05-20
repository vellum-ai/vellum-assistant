/**
 * File tree sidebar for the workspace browser. Fetches the assistant's
 * workspace directory listing, renders a recursive expandable tree, and
 * provides search filtering plus file/folder creation.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Plus,
  Search,
  Video,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { BottomSheet } from "@vellum/design-library/components/bottom-sheet";
import { Button } from "@vellum/design-library/components/button";
import { Input } from "@vellum/design-library/components/input";
import { PanelItem } from "@vellum/design-library/components/panel-item";
import { Popover } from "@vellum/design-library/components/popover";
import { client } from "@/generated/api/client.gen.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { formatFileSize } from "@/domains/workspace/utils/format-file-size.js";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface WorkspaceTreeEntry {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

interface WorkspaceTreeResponse {
  entries?: WorkspaceTreeEntry[];
}

function workspaceTreeRetrieveOptions(opts: {
  path: { assistant_id: string };
  query?: { path?: string; showHidden?: boolean };
}) {
  return queryOptions<WorkspaceTreeResponse>({
    queryFn: async () => {
      const query: Record<string, string> = {};
      if (opts.query?.path) query.path = opts.query.path;
      if (opts.query?.showHidden) query.showHidden = "true";
      const { data, error } = await client.get<WorkspaceTreeResponse, unknown>({
        url: "/v1/assistants/{assistant_id}/workspace/tree/",
        path: opts.path,
        query,
      });
      if (error) throw error;
      return data!;
    },
    queryKey: ["assistantsWorkspaceTreeRetrieve", opts],
  });
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
  searchLower,
  onToggleExpand,
  onSelectPath,
  depth,
}: {
  entry: WorkspaceTreeEntry;
  assistantId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  showHidden: boolean;
  searchLower: string;
  onToggleExpand: (path: string) => void;
  onSelectPath: (path: string) => void;
  depth: number;
}) {
  const entryPath = entry.path ?? "";
  const entryName = entry.name ?? "";
  const isDirectory = entry.type === "directory";
  const isExpanded = expandedPaths.has(entryPath);
  const isSelected = selectedPath === entryPath;
  const isHidden = entryName.startsWith(".");

  // Expand directories whose names match during search so their children are visible.
  const effectivelyExpanded =
    isDirectory && (isExpanded || searchLower.length > 0);

  const { data } = useQuery({
    ...workspaceTreeRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { path: entryPath, showHidden },
    }),
    enabled: isDirectory && effectivelyExpanded,
  });

  const children = useMemo(() => data?.entries ?? [], [data?.entries]);
  const nameMatches =
    searchLower === "" ||
    entryName.toLowerCase().includes(searchLower);

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

  return (
    <div>
      <button
        onClick={handleClick}
        className="group flex w-full items-center gap-1.5 px-2 py-1 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
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
        {!isDirectory && entry.size != null && (
          <span
            className="shrink-0 text-label-medium-default tabular-nums"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formatFileSize(entry.size)}
          </span>
        )}
      </button>
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
              searchLower={searchLower}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create item dialog — portaled to document.body
// ---------------------------------------------------------------------------

interface CreateItemDialogProps {
  kind: "file" | "folder";
  onCancel: () => void;
  onConfirm: (name: string) => void;
  pending: boolean;
  error: string | null;
}

function CreateItemDialog({
  kind,
  onCancel,
  onConfirm,
  pending,
  error,
}: CreateItemDialogProps) {
  const [name, setName] = useState("");

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) onConfirm(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="mx-4 w-full max-w-sm rounded-xl border p-5 shadow-xl"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
        }}
      >
        <h2
          className="mb-3 text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          {kind === "file" ? "New File" : "New Folder"}
        </h2>
        <Input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === "file" ? "filename.md" : "folder-name"}
          errorText={error ?? undefined}
          fullWidth
          wrapperClassName="mb-3"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outlined"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
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
  onToggleExpand,
  onExpandPath,
  onSelectPath,
  onToggleShowHidden,
}: {
  assistantId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  showHidden: boolean;
  onToggleExpand: (path: string) => void;
  onExpandPath: (path: string) => void;
  onSelectPath: (path: string) => void;
  onToggleShowHidden: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();

  const [menuOpen, setMenuOpen] = useState(false);

  const [dialogKind, setDialogKind] = useState<"file" | "folder" | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const { data, isLoading } = useQuery(
    workspaceTreeRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { showHidden },
    }),
  );

  const invalidateTree = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["assistantsWorkspaceTreeRetrieve"],
    });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: { kind: "file" | "folder"; name: string }) => {
      const url =
        input.kind === "file"
          ? "/v1/assistants/{assistant_id}/workspace/write/"
          : "/v1/assistants/{assistant_id}/workspace/mkdir/";
      const body =
        input.kind === "file"
          ? { path: input.name, content: "", encoding: "utf8" }
          : { path: input.name };
      const { error, response } = await client.post<unknown, unknown>({
        url,
        path: { assistant_id: assistantId },
        body,
        headers: { "Content-Type": "application/json" },
        throwOnError: false,
      });
      if (error || !response?.ok) {
        throw new Error(
          typeof error === "string"
            ? error
            : "Failed to create — check the name and try again.",
        );
      }
      return input;
    },
    onSuccess: (input) => {
      setDialogKind(null);
      setDialogError(null);
      invalidateTree();
      if (input.kind === "file") {
        onSelectPath(input.name);
      } else {
        onExpandPath(input.name);
      }
    },
    onError: (err: unknown) => {
      setDialogError(err instanceof Error ? err.message : "Failed to create.");
    },
  });

  const handleConfirm = useCallback(
    (name: string) => {
      if (!dialogKind) return;
      setDialogError(null);
      createMutation.mutate({ kind: dialogKind, name });
    },
    [dialogKind, createMutation],
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
              setDialogError(null);
              setDialogKind(kind);
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
        ) : !data?.entries?.length ? (
          <p
            className="px-3 py-4 text-center text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            No files found
          </p>
        ) : (
          data.entries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              assistantId={assistantId}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              showHidden={showHidden}
              searchLower={searchLower}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
              depth={0}
            />
          ))
        )}
      </div>

      {dialogKind !== null && (
        <CreateItemDialog
          key={dialogKind}
          kind={dialogKind}
          onCancel={() => {
            setDialogKind(null);
            setDialogError(null);
          }}
          onConfirm={handleConfirm}
          pending={createMutation.isPending}
          error={dialogError}
        />
      )}
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
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          iconOnly={<Plus aria-hidden />}
          aria-label="Create new file or folder"
          title="New file or folder"
          tintColor="var(--content-tertiary)"
        />
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        role="menu"
        className="w-44 overflow-hidden p-0"
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() => onSelectKind("file")}
          className="w-full justify-start rounded-none"
          leftIcon={
            <FilePlus aria-hidden style={{ color: "var(--content-tertiary)" }} />
          }
          role="menuitem"
        >
          New File
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onSelectKind("folder")}
          className="w-full justify-start rounded-none"
          leftIcon={
            <FolderPlus aria-hidden style={{ color: "var(--content-tertiary)" }} />
          }
          role="menuitem"
        >
          New Folder
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}
