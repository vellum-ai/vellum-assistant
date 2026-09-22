/**
 * A table of rows under column headers, drawn with the design library's
 * `Table`, with a copy-as-markdown control and optional row selection.
 * Presentational: it draws what it is given and owns its own prop types, so a
 * consumer maps its data (a `ui_show` table surface, a tool result) to these
 * props at its own boundary.
 */

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vellumai/design-library";
import { Check, Copy } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import { SelectionIndicator } from "@/domains/chat/components/surfaces/selection-indicator";

export interface DataTableColumn {
  id: string;
  label: string;
  /** Fixed width in px. Unset columns share the remaining width. */
  width?: number;
}

/** A cell's text, optionally led by an icon the consumer has already drawn. */
export interface DataTableRichCell {
  text: string;
  icon?: ReactNode;
}

export type DataTableCell = string | DataTableRichCell;

export interface DataTableRow {
  id: string;
  /** Cells keyed by column id. A missing key renders empty. */
  cells: Record<string, DataTableCell>;
  /** Whether this row can be selected when the table has a selection. */
  selectable?: boolean;
}

export interface DataTableSelection {
  mode: "single" | "multiple";
  selectedIds: readonly string[];
  onToggle: (rowId: string) => void;
}

export interface DataTableProps {
  columns: readonly DataTableColumn[];
  rows: readonly DataTableRow[];
  caption?: string;
  /**
   * Names the table's scroll area, which a keyboard can focus while the table
   * is too wide to show every column. Defaults to the caption.
   */
  label?: string;
  /** Row selection, when the table is a choice rather than a readout. */
  selection?: DataTableSelection;
  /**
   * Draws a cell's text. Defaults to the text itself in the table's body
   * type; a consumer whose cells are machine values passes `MachineText`.
   */
  renderCell?: (text: string) => ReactNode;
  /**
   * Draws the copy-as-markdown control above the table. Off for a consumer
   * that offers copying its own way, such as a detail panel field.
   */
  copyable?: boolean;
}

function cellText(cell: DataTableCell | undefined): string {
  if (cell === undefined) {
    return "";
  }
  return typeof cell === "string" ? cell : cell.text;
}

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The table as GitHub-flavored markdown, for the copy control. */
export function tableToMarkdown(
  columns: readonly DataTableColumn[],
  rows: readonly DataTableRow[],
): string {
  const header =
    "| " + columns.map((c) => escapeMd(c.label)).join(" | ") + " |";
  const separator = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = rows.map(
    (row) =>
      "| " +
      columns.map((col) => escapeMd(cellText(row.cells[col.id]))).join(" | ") +
      " |",
  );
  return [header, separator, ...body].join("\n");
}

function widthStyle(column: DataTableColumn) {
  return column.width ? { width: `${column.width}px` } : undefined;
}

function renderPlainCell(text: string): ReactNode {
  return text;
}

export function DataTable({
  columns,
  rows,
  caption,
  label,
  selection,
  renderCell = renderPlainCell,
  copyable = true,
}: DataTableProps) {
  const { t } = useTranslation("chat");
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("tableSurface.copyFailed"),
  });
  const handleCopy = useCallback(
    () => copy(tableToMarkdown(columns, rows)),
    [copy, columns, rows],
  );

  return (
    <div>
      {copyable && (
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded p-1 text-body-small-default text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
            aria-label={t("tableSurface.copyAria")}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? t("tableSurface.copied") : t("tableSurface.copy")}
          </button>
        </div>
      )}
      {/* The host arbitrates horizontal gestures on the scroll container. */}
      <Table
        density="compact"
        containerProps={{
          "data-owns-horizontal-scroll": "",
          // The first name with something in it: a surface title or caption
          // can arrive blank, which would name the region nothing.
          "aria-label":
            [label, caption].find((name) => name?.trim()) ??
            t("tableSurface.table"),
        }}
      >
        {caption && <TableCaption>{caption}</TableCaption>}
        <TableHeader>
          <TableRow>
            {selection && <TableHead className="w-10" />}
            {columns.map((col) => (
              <TableHead key={col.id} style={widthStyle(col)}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const isSelected =
              selection !== undefined && selection.selectedIds.includes(row.id);
            const rowSelectable =
              selection !== undefined && row.selectable !== false;

            return (
              <TableRow
                key={row.id}
                interactive={rowSelectable}
                selected={isSelected}
                onClick={() => rowSelectable && selection.onToggle(row.id)}
              >
                {selection && (
                  <TableCell>
                    {rowSelectable && (
                      <SelectionIndicator
                        selected={isSelected}
                        single={selection.mode === "single"}
                      />
                    )}
                  </TableCell>
                )}
                {columns.map((col) => {
                  const cell = row.cells[col.id];
                  return (
                    <TableCell key={col.id} style={widthStyle(col)}>
                      {typeof cell === "object" && cell.icon ? (
                        <span className="flex items-center gap-1.5">
                          {cell.icon}
                          {renderCell(cell.text)}
                        </span>
                      ) : (
                        renderCell(cellText(cell))
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
