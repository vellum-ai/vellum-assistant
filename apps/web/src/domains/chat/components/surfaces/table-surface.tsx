
import { Check, Copy, icons } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sfSymbolToLucideName } from "@/domains/chat/components/surfaces/sf-symbol-map.js";

import type { Surface } from "@/domains/chat/types/types.js";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container.js";

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
  const data = surface.data as unknown as TableSurfaceData;
  const selectionMode = data.selectionMode ?? "none";

  // Derive selection from server data; recomputed when rows change.
  const dataSelectedIds = useMemo(
    () => data.rows.filter((row) => row.selected).map((row) => row.id),
    [data.rows],
  );

  // Track which data reference the local overrides apply to. When data
  // changes the overrides are discarded and we fall back to dataSelectedIds.
  const [localState, setLocalState] = useState<{
    source: TableRow[];
    ids: string[];
  } | null>(null);

  const selectedIds =
    localState && localState.source === data.rows
      ? localState.ids
      : dataSelectedIds;

  const handleToggle = useCallback(
    (rowId: string) => {
      if (selectionMode === "none") return;

      const prev = selectedIds;
      const next =
        selectionMode === "single"
          ? prev.includes(rowId) ? [] : [rowId]
          : prev.includes(rowId)
            ? prev.filter((id) => id !== rowId)
            : [...prev, rowId];

      setLocalState({ source: data.rows, ids: next });
    },
    [selectionMode, selectedIds, data.rows],
  );

  const handleAction = useCallback(
    (surfaceId: string, actionId: string, data?: Record<string, unknown>) => {
      onAction(surfaceId, actionId, { ...data, selectedIds });
    },
    [onAction, selectedIds],
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
            className="flex items-center gap-1 rounded p-1 text-body-small-default text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-moss-600 dark:hover:text-stone-200"
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
          <tbody className="divide-y divide-stone-100 dark:divide-moss-600">
            {data.rows.map((row) => {
              const isSelected = selectedIds.includes(row.id);
              const rowSelectable = isSelectable && row.selectable !== false;

              return (
                <tr
                  key={row.id}
                  onClick={() => rowSelectable && handleToggle(row.id)}
                  className={`transition-colors ${
                    rowSelectable
                      ? "cursor-pointer hover:bg-stone-50 dark:hover:bg-moss-600"
                      : ""
                  } ${
                    isSelected
                      ? "bg-forest-50 dark:bg-forest-950"
                      : ""
                  }`}
                >
                  {isSelectable && (
                    <td className="px-3 py-2">
                      {rowSelectable && (
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                            isSelected
                              ? "border-forest-600 bg-forest-600 text-white"
                              : "border-stone-300 dark:border-moss-500"
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
                        className="px-3 py-2 text-stone-700 dark:text-stone-300"
                        style={col.width ? { width: `${col.width}px` } : undefined}
                      >
                        {isRichCell(cell) ? (
                          <span className="flex items-center gap-1.5">
                            {cell.icon && (() => {
                              const lucideName = sfSymbolToLucideName(cell.icon);
                              const LucideIcon = lucideName ? icons[lucideName as keyof typeof icons] : undefined;
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
