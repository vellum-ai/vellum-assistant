/**
 * Read-only grid for an already-parsed rectangular table, shared by every
 * tabular reader in the document drawer.
 *
 * Rows are virtualized: an exported spreadsheet routinely runs to thousands of
 * rows, and mounting a `<tr>` per row would cost more than reading the file.
 * `TableVirtuoso` renders real table elements with a sticky header, so the grid
 * keeps table semantics (screen readers, column alignment) while only the
 * visible slice is in the DOM.
 *
 * Purely presentational: the caller owns the bytes and the parse, and may
 * override the footer sentence, drop it, and set the empty-grid copy so a
 * reader can name the unit it is showing.
 */

import { useCallback, type ReactNode } from "react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";

import { Typography } from "@vellumai/design-library";

import type { ParsedCsv } from "@/domains/chat/components/local-file/preview/csv";
import { PreviewNotice } from "@/domains/chat/components/local-file/preview/preview-notice";
import { useTranslation } from "@/i18n";

/**
 * Rows rendered before the viewport is measured. Virtuoso needs a height to
 * decide what is visible, and there is none on the first paint (nor in a
 * headless test DOM), so this seeds a first screenful that the real
 * measurement then takes over from.
 */
const INITIAL_ROW_COUNT = 30;

const CELL_CLASSES =
  "border-b border-r border-[var(--border-element)] px-2 py-1 align-top last:border-r-0";

const TABLE_COMPONENTS: TableComponents<string[]> = {
  Table: ({ style, ...props }) => (
    <table
      {...props}
      // `min-w-max` keeps narrow cells at their natural width and lets a wide
      // file scroll sideways inside the scroller rather than squeezing.
      className="w-full min-w-max border-collapse text-body-small-default text-[var(--content-default)]"
      style={style}
    />
  ),
  TableRow: ({ item: _item, ...props }) => <tr {...props} />,
};

export interface TabularGridProps extends ParsedCsv {
  /**
   * Already-translated footer sentence, in place of the row and column count.
   * `null` draws no footer, for a caller that shows the sentence itself.
   */
  summary?: string | null;
  /** Already-translated copy for a grid with no columns. */
  emptyLabel?: string;
}

/**
 * Columns the grid draws: the header row when the parse found one, else the
 * width of the first record. Exported so a caller counting the same table for
 * its own footer sentence counts it the same way.
 */
export function columnCountOf(grid: ParsedCsv): number {
  return grid.headers?.length ?? grid.rows[0]?.length ?? 0;
}

/**
 * What a cell draws. An empty span builds no line box, so a row of empty
 * cells would sit shorter than the rows around it.
 */
function cellText(cell: string): string {
  return cell === "" ? "\u00a0" : cell;
}

export function TabularGrid({
  summary,
  emptyLabel,
  ...grid
}: TabularGridProps): ReactNode {
  const { t } = useTranslation("chat");
  const { headers, rows, truncated } = grid;

  const fixedHeaderContent = useCallback(() => {
    if (headers === null) {
      return null;
    }
    return (
      <tr>
        {headers.map((cell, index) => (
          <th
            // Header labels repeat in real files, so the column index is the
            // only stable identity here.
            key={index}
            scope="col"
            title={cell}
            className={`${CELL_CLASSES} bg-[var(--surface-sunken)] text-left text-body-small-emphasised`}
          >
            <span className="block max-w-[20rem] truncate">
              {cellText(cell)}
            </span>
          </th>
        ))}
      </tr>
    );
  }, [headers]);

  const columnCount = columnCountOf(grid);
  if (columnCount === 0) {
    return (
      <PreviewNotice>{emptyLabel ?? t("csvPreview.emptyFile")}</PreviewNotice>
    );
  }

  return (
    <div data-slot="tabular-grid" className="flex h-full min-h-0 flex-col">
      <TableVirtuoso
        data={rows}
        initialItemCount={Math.min(rows.length, INITIAL_ROW_COUNT)}
        components={TABLE_COMPONENTS}
        fixedHeaderContent={headers === null ? undefined : fixedHeaderContent}
        itemContent={(_index, row) =>
          row.map((cell, columnIndex) => (
            <td key={columnIndex} title={cell} className={CELL_CLASSES}>
              <span className="block max-w-[20rem] truncate">
                {cellText(cell)}
              </span>
            </td>
          ))
        }
        className="min-h-0 flex-1"
      />
      {summary === null ? null : (
        <Typography
          as="p"
          variant="label-small-default"
          className="shrink-0 border-t border-[var(--border-element)] px-3 py-1.5 text-[var(--content-tertiary)]"
        >
          {summary ??
            (truncated
              ? t("csvPreview.summaryTruncated", {
                  rows: rows.length,
                  columns: columnCount,
                })
              : t("csvPreview.summary", {
                  rows: rows.length,
                  columns: columnCount,
                }))}
        </Typography>
      )}
    </div>
  );
}
