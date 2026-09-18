import {
  type TableCellValue,
  type TableSurfaceData,
  TableSurfaceDataSchema,
} from "@vellumai/assistant-api";
import { useMemo } from "react";

import {
  DataTable,
  type DataTableCell,
  type DataTableRow,
  type DataTableSelection,
} from "@/domains/chat/components/data-table";
import { sfSymbolToLucideIcon } from "@/domains/chat/components/surfaces/sf-symbol-map";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useSelectionState } from "@/domains/chat/components/surfaces/use-selection-state";
import type { Surface } from "@/domains/chat/types/types";
import { cn } from "@/utils/misc";

// ---------------------------------------------------------------------------
// Wire to props
// ---------------------------------------------------------------------------

function iconColorClass(iconColor?: string): string {
  switch (iconColor) {
    case "success":
      return "text-[var(--system-positive-strong)]";
    case "warning":
      return "text-[var(--system-mid-strong)]";
    case "error":
      return "text-[var(--system-negative-strong)]";
    case "muted":
      return "text-[var(--content-tertiary)]";
    default:
      return "text-[var(--content-default)]";
  }
}

/** The icon a rich cell names as an SF Symbol, drawn for the table. */
function cellIcon(cell: TableCellValue) {
  if (!cell.icon) {
    return undefined;
  }
  const LucideIcon = sfSymbolToLucideIcon(cell.icon);
  return LucideIcon ? (
    <LucideIcon
      className={cn("h-4 w-4", iconColorClass(cell.iconColor))}
      aria-hidden
    />
  ) : (
    <span className={iconColorClass(cell.iconColor)} aria-hidden>
      {cell.icon}
    </span>
  );
}

function toDataTableCell(cell: string | TableCellValue): DataTableCell {
  return typeof cell === "string"
    ? cell
    : { text: cell.text, icon: cellIcon(cell) };
}

function toDataTableRows(rows: TableSurfaceData["rows"]): DataTableRow[] {
  return rows.map((row) => ({
    id: row.id,
    selectable: row.selectable,
    cells: Object.fromEntries(
      Object.entries(row.cells).map(([id, cell]) => [
        id,
        toDataTableCell(cell),
      ]),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface TableSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

export function TableSurface({ surface, onAction }: TableSurfaceProps) {
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant — malformed deliveries with no `rows`/`columns` collapse to
  // empty arrays instead of crashing on `data.rows.filter`, and a near-empty
  // container is the right shape for "we don't know what to show"). Memoized
  // on the payload identity because `useSelectionState` keys its optimistic
  // overrides on the rows array's reference.
  const data = useMemo<TableSurfaceData>(() => {
    const parsed = TableSurfaceDataSchema.safeParse(surface.data);
    return parsed.success ? parsed.data : { columns: [], rows: [] };
  }, [surface.data]);
  const selectionMode = data.selectionMode ?? "none";

  const { selectedIds, handleToggle, handleAction } = useSelectionState(
    data.rows,
    selectionMode,
    onAction,
  );

  const rows = useMemo(() => toDataTableRows(data.rows), [data.rows]);
  const selection: DataTableSelection | undefined =
    selectionMode === "none"
      ? undefined
      : { mode: selectionMode, selectedIds, onToggle: handleToggle };

  return (
    <SurfaceContainer surface={surface} onAction={handleAction}>
      <DataTable
        columns={data.columns}
        rows={rows}
        caption={data.caption}
        selection={selection}
      />
    </SurfaceContainer>
  );
}
