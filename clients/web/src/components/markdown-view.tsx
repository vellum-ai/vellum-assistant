/**
 * A markdown file, formatted, with its source one click away.
 *
 * For a surface that only shows the file: it owns the mode and pairs the
 * shared `FileViewModeControl` with the two views. The source is `SourcePre`,
 * the element a file's text is shown in elsewhere, unfolded, because the pane
 * scrolls and a file is not tool output to clamp. It is the file's own text,
 * so the frontmatter the formatted view leaves out is here.
 *
 * The view fills its pane and scrolls inside it, so the host can hand it a
 * bounded box without knowing which mode is showing. A surface that does
 * something else with the mode, such as the workspace viewer, which edits in
 * source, uses `FileViewModeControl` directly instead.
 */

import { useState } from "react";

import { cn } from "@vellumai/design-library/utils/cn";

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
  /** Padding for the formatted view, which the source view sets itself. */
  className?: string;
}) {
  const [mode, setMode] = useState<FileViewMode>(defaultMode);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex justify-end px-4 pt-2">
        <FileViewModeControl mode={mode} onChange={setMode} />
      </div>
      {mode === "formatted" ? (
        <div className={cn("min-h-0 flex-1 overflow-auto", className)}>
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
