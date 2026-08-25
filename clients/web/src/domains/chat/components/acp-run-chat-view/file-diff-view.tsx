import {
  DiffRows,
  type DiffRow as SharedDiffRow,
} from "@/components/diff-rows";

import { computeLineDiff, type DiffRow } from "./compute-line-diff";
import { useTranslation } from "@/i18n";

export interface FileDiffViewProps {
  /** Repo-relative path of the file being diffed (used for the a11y label). */
  path: string;
  /** File contents before the change. Empty/undefined → treated as a new file. */
  oldText?: string;
  /** File contents after the change. Empty/undefined → treated as a deletion. */
  newText?: string;
}

/**
 * The `too-large` sentinel is a sentence, not a diff line, so it renders as a
 * notice instead of going through the shared row renderer.
 */
function isDiffRow(row: DiffRow): row is DiffRow & SharedDiffRow {
  return row.type !== "too-large";
}

/**
 * Unified file-diff renderer for ACP run tool calls. Pure: it derives its rows
 * from `computeLineDiff` and delegates row presentation to the shared
 * {@link DiffRows}.
 *
 * Body-only: navigation (Back + breadcrumb) lives in the chat view's shared
 * header.
 */
export function FileDiffView({ path, oldText, newText }: FileDiffViewProps) {
  const { t } = useTranslation("chat");
  const rows = computeLineDiff(oldText ?? "", newText ?? "");
  const tooLarge = rows.find((row) => row.type === "too-large");

  return (
    <div
      aria-label={t("fileDiffView.diffForAria", { path })}
      data-testid="acp-chat-file-diff"
      className="flex flex-col overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]"
    >
      {tooLarge ? (
        <div
          data-diff-type="too-large"
          className="px-3 py-2 font-mono text-body-small-lighter whitespace-pre-wrap text-[var(--content-tertiary)] italic"
        >
          {tooLarge.text}
        </div>
      ) : (
        <DiffRows rows={rows.filter(isDiffRow)} />
      )}
    </div>
  );
}
