import { FileIcon, FileText, Image as ImageIcon, Video } from "lucide-react";
import type { ReactNode } from "react";

import { formatFileSize } from "@/utils/format-file-size";

import {
  WorkspaceFileSwitcher,
  type WorkspaceFilePickerControl,
} from "./workspace-file-switcher";

function FileHeaderIcon({ mimeType }: { mimeType: string }) {
  const baseMime = mimeType.split(";", 1)[0].trim();
  let Icon = FileText;
  if (baseMime.startsWith("image/")) {
    Icon = ImageIcon;
  } else if (baseMime.startsWith("video/")) {
    Icon = Video;
  } else if (
    !baseMime.startsWith("text/") &&
    baseMime !== "application/json" &&
    baseMime !== "application/octet-stream"
  ) {
    Icon = FileIcon;
  }
  return (
    <span
      data-slot="workspace-file-icon"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 10%, transparent)",
      }}
    >
      <Icon
        className="h-3.5 w-3.5 text-[var(--content-default)]"
        aria-hidden
      />
    </span>
  );
}

interface WorkspaceFileHeaderProps {
  selectedPath: string | null;
  name: string;
  mimeType: string;
  size?: number;
  picker?: WorkspaceFilePickerControl;
  rightContent?: ReactNode;
}

export function WorkspaceFileHeader({
  selectedPath,
  name,
  mimeType,
  size,
  picker,
  rightContent,
}: WorkspaceFileHeaderProps) {
  const icon = <FileHeaderIcon mimeType={mimeType} />;
  return (
    <div
      data-slot="workspace-file-header"
      className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2.5"
      style={{ borderColor: "var(--border-element)" }}
    >
      {picker ? (
        <WorkspaceFileSwitcher
          {...picker}
          selectedPath={selectedPath}
          icon={icon}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <span
            data-slot="workspace-file-name"
            className="truncate text-body-medium-default text-[var(--content-default)]"
          >
            {name}
          </span>
          {size != null && (
            <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
              {formatFileSize(size)}
            </span>
          )}
        </div>
      )}
      {rightContent && <div className="shrink-0">{rightContent}</div>}
    </div>
  );
}
