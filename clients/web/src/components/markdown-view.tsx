/**
 * A markdown file, formatted, with its source one click away.
 *
 * For a surface that only shows the file: it owns the mode itself and pairs
 * the shared `FileViewModeControl` with the two views. The source is
 * `SourcePre`, the same element the workspace viewer and the skills tab show
 * a file's text in, unfolded — this pane scrolls, and a file is not tool
 * output to be clamped. It is the file's own text, so the frontmatter the
 * formatted view leaves out is here.
 *
 * A surface that does something else with the mode (the workspace viewer
 * edits in source) uses `FileViewModeControl` directly instead.
 */

import { useState } from "react";

import { SourcePre } from "@/components/file-editor";
import { FileMarkdown } from "@/components/file-markdown";
import {
  FileViewModeControl,
  type FileViewMode,
} from "@/components/file-view-mode";

export function MarkdownView({
  content,
  defaultMode = "formatted",
  className,
}: {
  content: string;
  /**
   * Which mode to open in. Defaults to formatted; a surface whose content is
   * usually read as source can open there instead.
   */
  defaultMode?: FileViewMode;
  /** Extra classes for the content area, e.g. the padding a viewer wants. */
  className?: string;
}) {
  const [mode, setMode] = useState<FileViewMode>(defaultMode);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex justify-end px-4 pt-2">
        <FileViewModeControl mode={mode} onChange={setMode} />
      </div>
      {mode === "formatted" ? (
        <div className={className}>
          <FileMarkdown content={content} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <SourcePre content={content} readOnly />
        </div>
      )}
    </div>
  );
}
