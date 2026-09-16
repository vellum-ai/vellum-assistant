import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  Trash2,
  Video,
} from "lucide-react";
import { memo } from "react";

import { useTranslation } from "@/i18n";
import { formatFileSize } from "@/utils/format-file-size";
import type { WorkspaceTreeEntry } from "@/domains/workspace/utils/build-workspace-tree-rows";
import { isHiddenPath } from "@/domains/workspace/utils/is-hidden-path";
import { ContextMenu } from "@vellumai/design-library/components/context-menu";

export interface EntryTarget {
  path: string;
  name: string;
  isDirectory: boolean;
}

interface WorkspaceTreeRowProps {
  entry: WorkspaceTreeEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: (path: string) => void;
  onSelectPath: (path: string) => void;
  onRequestDelete: (target: EntryTarget) => void;
  onRequestRename: (target: EntryTarget) => void;
  onRequestCreate: (input: {
    kind: "file" | "folder";
    parentPath: string;
  }) => void;
}

function FileIconForEntry({ entry }: { entry: WorkspaceTreeEntry }) {
  const style = { color: "var(--content-tertiary)" };
  if (entry.type === "directory") {
    return <Folder className="h-4 w-4 shrink-0" style={style} />;
  }
  if (entry.mimeType?.startsWith("image/")) {
    return <ImageIcon className="h-4 w-4 shrink-0" style={style} />;
  }
  if (entry.mimeType?.startsWith("video/")) {
    return <Video className="h-4 w-4 shrink-0" style={style} />;
  }
  return <FileText className="h-4 w-4 shrink-0" style={style} />;
}

/**
 * One row of the workspace file tree. Folders toggle open on click and files
 * select; both carry a context menu unless their path has a hidden segment,
 * which the daemon refuses to write, rename, or delete.
 */
export const WorkspaceTreeRow = memo(function WorkspaceTreeRow({
  entry,
  depth,
  isExpanded,
  isSelected,
  onToggleExpand,
  onSelectPath,
  onRequestDelete,
  onRequestRename,
  onRequestCreate,
}: WorkspaceTreeRowProps) {
  const { t } = useTranslation("workspace");
  const isDirectory = entry.type === "directory";
  const isHidden = entry.name.startsWith(".");
  const hasMenu = !isHiddenPath(entry.path);
  const target = { path: entry.path, name: entry.name, isDirectory };

  const row = (
    <button
      type="button"
      onClick={() =>
        isDirectory ? onToggleExpand(entry.path) : onSelectPath(entry.path)
      }
      aria-expanded={isDirectory ? isExpanded : undefined}
      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
      style={{
        paddingLeft: `${depth * 14 + 8}px`,
        paddingRight: "8px",
        color:
          isHidden && !isSelected
            ? "var(--content-tertiary)"
            : "var(--content-default)",
        backgroundColor: isSelected
          ? "color-mix(in oklab, var(--primary-base) 12%, transparent)"
          : undefined,
        opacity: isHidden && !isSelected ? 0.7 : 1,
      }}
    >
      {isDirectory ? (
        isExpanded ? (
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
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.size !== null && (
        <span
          className="shrink-0 text-label-medium-default tabular-nums"
          style={{ color: "var(--content-tertiary)" }}
        >
          {formatFileSize(entry.size)}
        </span>
      )}
    </button>
  );

  if (!hasMenu) {
    return row;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content>
        {isDirectory && (
          <>
            <ContextMenu.Item
              leftIcon={<FilePlus className="h-3.5 w-3.5" />}
              onSelect={() =>
                onRequestCreate({ kind: "file", parentPath: entry.path })
              }
            >
              {t("workspaceTree.newFile")}
            </ContextMenu.Item>
            <ContextMenu.Item
              leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
              onSelect={() =>
                onRequestCreate({ kind: "folder", parentPath: entry.path })
              }
            >
              {t("workspaceTree.newFolder")}
            </ContextMenu.Item>
            <ContextMenu.Separator />
          </>
        )}
        <ContextMenu.Item
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          onSelect={() => onRequestDelete(target)}
        >
          {t("workspaceTree.delete")}
        </ContextMenu.Item>
        <ContextMenu.Item
          leftIcon={<Pencil className="h-3.5 w-3.5" />}
          onSelect={() => onRequestRename(target)}
        >
          {t("workspaceTree.rename")}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
});
