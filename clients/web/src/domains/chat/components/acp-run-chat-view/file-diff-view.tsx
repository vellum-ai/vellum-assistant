import { computeLineDiff, type DiffRow } from "./compute-line-diff";

export interface FileDiffViewProps {
  /** Repo-relative path of the file being diffed (used for the a11y label). */
  path: string;
  /** File contents before the change. Empty/undefined → treated as a new file. */
  oldText?: string;
  /** File contents after the change. Empty/undefined → treated as a deletion. */
  newText?: string;
}

const GUTTER = "—";

function rowSurfaceClass(type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]";
    case "del":
      return "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]";
    case "too-large":
      return "text-[var(--content-tertiary)] italic";
    case "ctx":
    default:
      return "text-[var(--content-tertiary)]";
  }
}

function rowMarker(type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return "+";
    case "del":
      return "-";
    default:
      return " ";
  }
}

/**
 * Presentational unified file-diff renderer. Pure: it derives its rows from
 * `computeLineDiff` and renders monospace add/del/ctx lines with design tokens.
 *
 * Body-only: navigation (Back + breadcrumb) lives in the chat view's shared
 * header.
 */
export function FileDiffView({ path, oldText, newText }: FileDiffViewProps) {
  const rows = computeLineDiff(oldText ?? "", newText ?? "");

  return (
    <div
      aria-label={`Diff for ${path}`}
      data-testid="acp-chat-file-diff"
      className="flex flex-col overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]"
    >
      <div className="overflow-x-auto font-mono text-xs">
        {rows.map((row, idx) => (
          <DiffLine key={idx} row={row} />
        ))}
      </div>
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === "too-large") {
    return (
      <div
        data-diff-type="too-large"
        className={`px-3 py-2 whitespace-pre-wrap ${rowSurfaceClass(row.type)}`}
      >
        {row.text}
      </div>
    );
  }

  return (
    <div
      data-diff-type={row.type}
      className={`flex items-start whitespace-pre ${rowSurfaceClass(row.type)}`}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-[var(--content-tertiary)] tabular-nums">
        {row.oldNo ?? GUTTER}
      </span>
      <span className="w-10 shrink-0 select-none px-2 text-right text-[var(--content-tertiary)] tabular-nums">
        {row.newNo ?? GUTTER}
      </span>
      <span className="w-4 shrink-0 select-none text-center">{rowMarker(row.type)}</span>
      <span className="flex-1 pr-3">{row.text}</span>
    </div>
  );
}
