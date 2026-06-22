import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sfSymbolToLucideIcon } from "@/domains/chat/components/surfaces/sf-symbol-map";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useSelectionState } from "@/domains/chat/components/surfaces/use-selection-state";
import type { Surface } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableColumn {
  id: string;
  label: string;
  width?: number;
}

// The daemon's surface protocol allows rich cell values
// (`{ text, icon?, iconColor? }`) in addition to plain strings.
// Mirrors `TableCellValue` in
// `vellum-assistant/assistant/src/daemon/message-types/surfaces.ts`.
interface TableCellValue {
  text: string;
  icon?: string;
  iconColor?: string;
}

type TableCell = string | TableCellValue;

function isRichCell(cell: TableCell | undefined): cell is TableCellValue {
  return typeof cell === "object" && cell !== null && "text" in cell;
}

function iconColorClass(iconColor?: string): string {
  switch (iconColor) {
    case "success": return "text-[var(--system-positive-strong)]";
    case "warning": return "text-[var(--system-mid-strong)]";
    case "error": return "text-[var(--system-negative-strong)]";
    case "muted": return "text-[var(--content-tertiary)]";
    default: return "text-[var(--content-default)]";
  }
}

interface TableRow {
  id: string;
  cells: Record<string, TableCell>;
  selectable?: boolean;
  selected?: boolean;
}

interface TableSurfaceData {
  columns: TableColumn[];
  rows: TableRow[];
  selectionMode?: "none" | "single" | "multiple";
  caption?: string;
}

interface TableSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function tableToMarkdown(columns: TableColumn[], rows: TableRow[]): string {
  const header = "| " + columns.map((c) => escapeMd(c.label)).join(" | ") + " |";
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
  // The daemon owns the surface payload shape; in practice we've seen
  // malformed deliveries (no `rows`, no `columns`) reach the renderer
  // — they surface as a hard crash on `data.rows.filter`. Default both
  // to empty arrays here so the row/column reads downstream stay safe.
  // A surface with no columns and no rows renders to a near-empty
  // container, which is the right shape for "we don't know what to
  // show" — not a thrown error inside React's render path.
  const rawData = surface.data as unknown as Partial<TableSurfaceData> | null;
  const data = useMemo<TableSurfaceData>(
    () => ({
      columns: rawData?.columns ?? [],
      rows: rawData?.rows ?? [],
      selectionMode: rawData?.selectionMode,
      caption: rawData?.caption,
    }),
    [rawData],
  );
  const selectionMode = data.selectionMode ?? "none";

  const { selectedIds, handleToggle, handleAction } = useSelectionState(
    data.rows,
    selectionMode,
    onAction,
  );

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    const md = tableToMarkdown(data.columns, data.rows);
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [data.columns, data.rows]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
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
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <table className="w-full text-left text-body-medium-lighter">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              {isSelectable && (
                <th className="w-10 px-3 py-2" />
              )}
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
                  className={`transition-colors ${
                    rowSelectable
                      ? "cursor-pointer hover:bg-[var(--surface-hover)]"
                      : ""
                  } ${
                    isSelected
                      ? "bg-[var(--system-positive-weak)]"
                      : ""
                  }`}
                >
                  {isSelectable && (
                    <td className="px-3 py-2">
                      {rowSelectable && (
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                            isSelected
                              ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
                              : "border-[var(--border-element)]"
                          } ${selectionMode === "single" ? "rounded-full" : "rounded"}`}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </span>
                      )}
                    </td>
                  )}
                  {data.columns.map((col) => {
                    const cell = row.cells[col.id];
                    return (
                      <td
                        key={col.id}
                        className="px-3 py-2 text-[var(--content-default)]"
                        style={col.width ? { width: `${col.width}px` } : undefined}
                      >
                        {isRichCell(cell) ? (
                          <span className="flex items-center gap-1.5">
                            {cell.icon && (() => {
                              const LucideIcon = sfSymbolToLucideIcon(cell.icon);
                              return LucideIcon ? (
                                <LucideIcon className={`h-4 w-4 ${iconColorClass(cell.iconColor)}`} aria-hidden />
                              ) : (
                                <span className={iconColorClass(cell.iconColor)} aria-hidden>
                                  {cell.icon}
                                </span>
                              );
                            })()}
                            {cell.text}
                          </span>
                        ) : (cell ?? "")}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {data.caption && (
          <p className="mt-2 text-body-small-default text-[var(--content-quiet)]">{data.caption}</p>
        )}
      </div>
    </SurfaceContainer>
  );
}
