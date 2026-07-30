/**
 * Inline markdown link to a local file. Keeps the transcript's file-link
 * styling and prepends a per-kind icon, staying inline-level so it does not
 * disturb line height or list bullets.
 */

import type { MouseEvent, ReactNode } from "react";

import { toast } from "@vellumai/design-library";

import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/domains/chat/components/local-file/local-file-icon";
import { filenameFromHref } from "@/domains/chat/components/local-file/local-file-target";
import { workspaceBasenameOf } from "@/domains/chat/utils/workspace-path-links";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

export interface LocalFileLinkProps {
  href: string;
  workspacePath: string | null;
  /**
   * Accepted so callers can pass the active assistant uniformly across the
   * local-file components. The link resolves nothing from the daemon itself.
   */
  assistantId?: string;
  /** The markdown label. */
  children: ReactNode;
  /** When provided, a click delegates here instead of opening the file. */
  onActivate?: () => void;
}

export function LocalFileLink({
  href,
  workspacePath,
  children,
  onActivate,
}: LocalFileLinkProps): ReactNode {
  const filename =
    workspacePath !== null
      ? workspaceBasenameOf(workspacePath)
      : filenameFromHref(href);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (onActivate) {
      onActivate();
      return;
    }
    if (workspacePath === null) {
      toast.error("This file isn't available here");
      return;
    }
    void openWorkspaceFile(workspacePath);
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="inline-flex items-baseline gap-1 cursor-pointer text-[var(--system-positive-strong)] underline hover:opacity-80"
    >
      <LocalFileIcon
        kind={localFileKindFromFilename(filename)}
        filename={filename}
        className="h-3.5 w-3.5 shrink-0 self-center"
      />
      {children}
    </a>
  );
}
