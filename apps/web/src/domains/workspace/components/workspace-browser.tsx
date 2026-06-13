/**
 * Top-level workspace browser layout. Renders a file tree sidebar (hidden on
 * mobile behind a drawer) and a file viewer pane side-by-side.
 */

import { useCallback, useState } from "react";

import { useSearchParams } from "react-router";

import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import { WorkspaceFileViewer } from "@/domains/workspace/components/workspace-file-viewer";
import {
  WorkspaceTree,
  type WorkspaceSortMode,
} from "@/domains/workspace/components/workspace-tree";

export type WorkspaceViewMode = "preview" | "source";

export function WorkspaceBrowser({ assistantId }: { assistantId: string }) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [searchParams] = useSearchParams();
  const [sortMode, setSortMode] = useState<WorkspaceSortMode>(() =>
    searchParams.get("sort") === "size" ? "size" : "name",
  );
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>("preview");

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleExpandPath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleSelectPath = useCallback((path: string) => {
    setSelectedPath(path);
    setDrawerOpen(false);
  }, []);

  const [lastDelete, setLastDelete] = useState<{ path: string } | null>(null);

  const handlePathDeleted = useCallback((path: string) => {
    const isDeleted = (p: string) => p === path || p.startsWith(`${path}/`);
    setSelectedPath((prev) => (prev !== null && isDeleted(prev) ? null : prev));
    setExpandedPaths((prev) => {
      const next = new Set([...prev].filter((p) => !isDeleted(p)));
      return next.size === prev.size ? prev : next;
    });
    setLastDelete({ path });
  }, []);

  const [lastRename, setLastRename] = useState<{
    from: string;
    to: string;
  } | null>(null);

  const handlePathRenamed = useCallback((oldPath: string, newPath: string) => {
    const remap = (p: string) =>
      p === oldPath
        ? newPath
        : p.startsWith(`${oldPath}/`)
          ? newPath + p.slice(oldPath.length)
          : p;
    setSelectedPath((prev) => (prev === null ? prev : remap(prev)));
    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        const mapped = remap(p);
        if (mapped !== p) changed = true;
        next.add(mapped);
      }
      return changed ? next : prev;
    });
    setLastRename({ from: oldPath, to: newPath });
  }, []);

  const treeProps = {
    assistantId,
    expandedPaths,
    selectedPath,
    showHidden,
    sortMode,
    onToggleExpand: handleToggleExpand,
    onExpandPath: handleExpandPath,
    onSelectPath: handleSelectPath,
    onToggleShowHidden: () => setShowHidden((v) => !v),
    onChangeSortMode: setSortMode,
    onPathDeleted: handlePathDeleted,
    onPathRenamed: handlePathRenamed,
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center sm:hidden">
        <MobileSidebarTrigger onClick={() => setDrawerOpen(true)} />
      </div>

      <MobileSidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Files"
      >
        <WorkspaceTree {...treeProps} />
      </MobileSidebarDrawer>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-[320px_1fr]">
        <div
          className="hidden min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border sm:flex"
          style={{
            backgroundColor: "var(--surface-overlay)",
            borderColor: "var(--border-base)",
          }}
        >
          <WorkspaceTree {...treeProps} />
        </div>
        <div
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border"
          style={{
            backgroundColor: "var(--surface-overlay)",
            borderColor: "var(--border-base)",
          }}
        >
          <WorkspaceFileViewer
            assistantId={assistantId}
            selectedPath={selectedPath}
            showHidden={showHidden}
            viewMode={viewMode}
            onChangeViewMode={setViewMode}
            onBrowse={() => setDrawerOpen(true)}
            pathRename={lastRename}
            pathDelete={lastDelete}
          />
        </div>
      </div>
    </div>
  );
}
