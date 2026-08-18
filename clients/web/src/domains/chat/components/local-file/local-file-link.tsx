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
import { toggleLocalFile } from "@/domains/chat/components/local-file/open-local-file";
import { workspaceBasenameOf } from "@/domains/chat/utils/workspace-path-links";
import { t } from "@/i18n";

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
  /** When provided, a click delegates here instead of opening the file. */
  onActivate?: () => void;
}

export function LocalFileLink({
  href,
  workspacePath,
  assistantId,
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
      toast.error(t("chat:localFileLink.unavailable"));
      return;
    }
    toggleLocalFile(workspacePath, filename, assistantId);
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
