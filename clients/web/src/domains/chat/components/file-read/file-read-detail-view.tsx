/**
 * Nested detail view for a subagent `file_read` pill. Replaces the generic
 * technical-details/output body (input JSON + raw output) with a clean file
 * header — the basename, with the full path beneath — and the file contents in
 * a monospace, copyable code block.
 *
 * Static / presentational: reads only the `input.path` + `result` the panel
 * already built into the `ToolDetailPayload` (see `buildSubagentStepDetails`).
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock } from "@/domains/chat/components/tool-detail-panel";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/** The trailing path segment, e.g. `a65ca0810511.txt` from a long workspace path. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function FileReadDetailView({ detail }: { detail: ToolDetailPayload }) {
  const path =
    typeof detail.input?.path === "string" ? detail.input.path : "";
  const fileName = path ? basenameOf(path) : "File";
  const content = detail.result ?? "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Typography
          variant="body-medium-default"
          as="h3"
          title={fileName}
          className="truncate text-[var(--content-emphasised)]"
        >
          {fileName}
        </Typography>
        {path && (
          <Typography
            variant="body-small-default"
            as="p"
            title={path}
            className="truncate text-[var(--content-tertiary)]"
          >
            {path}
          </Typography>
        )}
      </div>
      {content ? (
        <CodeBlock text={content} />
      ) : (
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {detail.status === "running" ? "Reading…" : "Empty file."}
        </Typography>
      )}
    </div>
  );
}
