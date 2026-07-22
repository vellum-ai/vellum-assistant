import {
  type TableCellValue,
  type TableColumn,
  type TableRow,
  type TableSurfaceData,
  TableSurfaceDataSchema,
} from "@vellumai/assistant-api";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SelectionIndicator } from "@/domains/chat/components/surfaces/selection-indicator";
import { sfSymbolToLucideIcon } from "@/domains/chat/components/surfaces/sf-symbol-map";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useSelectionState } from "@/domains/chat/components/surfaces/use-selection-state";
import type { Surface } from "@/domains/chat/types/types";
import { cn } from "@/utils/misc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TableCell = string | TableCellValue;

function isRichCell(cell: TableCell | undefined): cell is TableCellValue {
  return typeof cell === "object" && cell !== null && "text" in cell;
}

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

interface TableSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function tableToMarkdown(columns: TableColumn[], rows: TableRow[]): string {
  const header =
    "| " + columns.map((c) => escapeMd(c.label)).join(" | ") + " |";
  const separator = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = rows.map((row) => {
    const cells = columns.map((col) => {
      const cell = row.cells[col.id];
      const text = isRichCell(cell) ? cell.text : (cell ?? "");
      return escapeMd(String(text));
    });
    return "| " + cells.join(" | ") + " |";
  });
  return [header, separator, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

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

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      return;
    }
    const md = tableToMarkdown(data.columns, data.rows);
    navigator.clipboard
      .writeText(md)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current) {
          clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [data.columns, data.rows]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const isSelectable = selectionMode !== "none";

  return (
    <SurfaceContainer surface={surface} onAction={handleAction}>
      <div className="overflow-x-auto">
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded p-1 text-body-small-default text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
            aria-label="Copy table as markdown"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <table className="w-full text-left text-body-medium-lighter">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              {isSelectable && <th className="w-10 px-3 py-2" />}
              {data.columns.map((col) => (
                <th
                  key={col.id}
                  className="px-3 py-2 text-body-small-default text-[var(--content-quiet)]"
                  style={col.width ? { width: `${col.width}px` } : undefined}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-base)]">
            {data.rows.map((row) => {
              const isSelected = selectedIds.includes(row.id);
              const rowSelectable = isSelectable && row.selectable !== false;

              return (
                <tr
                  key={row.id}
                  onClick={() => rowSelectable && handleToggle(row.id)}
                  className={cn(
                    "transition-colors",
                    rowSelectable
                      ? "cursor-pointer hover:bg-[var(--surface-hover)]"
                      : "",
                    isSelected ? "bg-[var(--system-positive-weak)]" : "",
                  )}
                >
                  {isSelectable && (
                    <td className="px-3 py-2">
                      {rowSelectable && (
                        <SelectionIndicator
                          selected={isSelected}
                          single={selectionMode === "single"}
                        />
                      )}
                    </td>
                  )}
                  {data.columns.map((col) => {
                    const cell = row.cells[col.id];
                    return (
                      <td
                        key={col.id}
                        className="px-3 py-2 text-[var(--content-default)]"
                        style={
                          col.width ? { width: `${col.width}px` } : undefined
                        }
                      >
                        {isRichCell(cell) ? (
                          <span className="flex items-center gap-1.5">
                            {cell.icon &&
                              (() => {
                                const LucideIcon = sfSymbolToLucideIcon(
                                  cell.icon,
                                );
                                return LucideIcon ? (
                                  <LucideIcon
                                    className={cn(
                                      "h-4 w-4",
                                      iconColorClass(cell.iconColor),
                                    )}
                                    aria-hidden
                                  />
                                ) : (
                                  <span
                                    className={iconColorClass(cell.iconColor)}
                                    aria-hidden
                                  >
                                    {cell.icon}
                                  </span>
                                );
                              })()}
                            {cell.text}
                          </span>
                        ) : (
                          (cell ?? "")
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {data.caption && (
          <p className="mt-2 text-body-small-default text-[var(--content-quiet)]">
            {data.caption}
          </p>
        )}
      </div>
    </SurfaceContainer>
  );
}
