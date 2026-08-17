/**
 * Shared unified-diff row renderer: the one place that defines how a line diff
 * looks (gutter layout, add/del/ctx colors, wrapping). Every surface that
 * shows a diff (the skill revision history, the ACP chat file-diff view)
 * renders its rows through this component so a diff reads the same wherever it
 * appears.
 *
 * Lines always soft-wrap, with continuation lines aligned after the gutter; a
 * diff never scrolls horizontally. Prose diffs depend on this: a SKILL.md
 * paragraph is a single line, and GitHub's diff view wraps the same way.
 */

/** A single rendered line of a diff. */
export interface DiffRow {
  /** `meta` is a gap between hunks, rendered as a separator rather than text. */
  type: "add" | "del" | "ctx" | "meta";
  text: string;
  /** 1-based line number in the pre-change text, when the row exists there. */
  oldNo?: number;
  /** 1-based line number in the post-change text, when the row exists there. */
  newNo?: number;
}

export function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="font-mono text-body-small-lighter">
      {rows.map((row, index) => (
        <DiffLine key={index} row={row} />
      ))}
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === "meta") {
    return (
      <div
        data-diff-type="meta"
        className="px-3 py-0.5 text-[var(--content-faint)]"
        aria-hidden
      >
        ⋯
      </div>
    );
  }

  const isAdd = row.type === "add";
  const isDel = row.type === "del";

  return (
    <div
      data-diff-type={row.type}
      className={`flex whitespace-pre-wrap ${
        isAdd
          ? "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]"
          : isDel
            ? "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
            : "text-[var(--content-secondary)]"
      }`}
    >
      <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--content-faint)] tabular-nums">
        {row.oldNo ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--content-faint)] tabular-nums">
        {row.newNo ?? ""}
      </span>
      <span className="w-4 shrink-0 select-none text-center">
        {isAdd ? "+" : isDel ? "-" : " "}
      </span>
      <span className="min-w-0 flex-1 break-words pr-3">{row.text}</span>
    </div>
  );
}
