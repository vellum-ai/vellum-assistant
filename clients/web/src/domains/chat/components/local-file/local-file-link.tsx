/**
 * Inline markdown link to a local file. Keeps the transcript's file-link
 * styling and prepends a per-kind icon, staying inline-level so it does not
 * disturb line height or list bullets.
 */

import type { MouseEvent, ReactNode } from "react";

import { cn, textLinkVariants, toast } from "@vellumai/design-library";

import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/components/local-file/local-file-icon";
import { filenameFromHref } from "@/domains/chat/components/local-file/local-file-target";
import {
  localFileDestination,
  toggleLocalFile,
  useIsWorkspaceFileOpen,
} from "@/components/local-file/open-local-file";
import { workspaceBasenameOf } from "@/utils/workspace-path-links";
import { type ParseKeys, useTranslation } from "@/i18n";

export interface LocalFileLinkProps {
  href: string;
  workspacePath: string | null;
  /**
   * The active assistant, needed to read the file into the drawer. Without it
   * the click falls back to the workspace browser. A click is a toggle: on a
   * file already open in the drawer, it closes it.
   */
  assistantId?: string;
  /** The markdown label. */
  children: ReactNode;
  /** User-authored markdown keeps its original caption. */
  labelMode?: "action" | "markdown";
  /** Opens the file action chooser when the preview cannot reach the file. */
  onOpenFileOptions?: () => void;
}

export function LocalFileLink({
  href,
  workspacePath,
  assistantId,
  children,
  labelMode = "action",
  onOpenFileOptions,
}: LocalFileLinkProps): ReactNode {
  const { t } = useTranslation("chat");
  const filename =
    workspacePath !== null
      ? workspaceBasenameOf(workspacePath)
      : filenameFromHref(href);
  const destination = localFileDestination(filename, assistantId);
  const mode = onOpenFileOptions
    ? "options"
    : workspacePath === null
      ? "unavailable"
      : destination.mode;
  const isOpen = useIsWorkspaceFileOpen(
    mode === "preview" ? workspacePath : null,
  );

  let labelKey: ParseKeys<"chat">;
  switch (mode) {
    case "options":
      labelKey = "localFileLink.fileOptions";
      break;
    case "unavailable":
      labelKey = "localFileLink.unavailableLabel";
      break;
    case "workspace":
      labelKey = "localFileLink.openInWorkspace";
      break;
    case "preview":
      if (isOpen) {
        labelKey = "localFileLink.closePreview";
      } else if (
        destination.mode === "preview" &&
        destination.previewKind === "image"
      ) {
        labelKey = "localFileLink.viewImage";
      } else {
        labelKey = "localFileLink.openPreview";
      }
      break;
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (mode === "options") {
      onOpenFileOptions?.();
      return;
    }
    if (workspacePath === null) {
      toast.error(t("localFileLink.unavailable"));
      return;
    }
    toggleLocalFile(workspacePath, filename, assistantId);
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      aria-expanded={mode === "preview" ? isOpen : undefined}
      aria-haspopup={mode === "options" ? "dialog" : undefined}
      data-slot="text-link"
      className={cn(
        textLinkVariants(),
        "inline-flex max-w-full items-baseline gap-1",
      )}
    >
      <LocalFileIcon
        kind={localFileKindFromFilename(filename)}
        filename={filename}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {labelMode === "markdown" ? children : t(labelKey, { filename })}
      </span>
    </a>
  );
}
