/* eslint-disable no-restricted-syntax -- LUM-1768: file contains dark: pairs pending semantic-token migration */

import { Check, icons } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { sfSymbolToLucideName } from "@/domains/chat/components/surfaces/sf-symbol-map.js";

import type { Surface } from "@/domains/chat/types/types.js";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  selected?: boolean;
}

interface ListSurfaceData {
  items: ListItem[];
  selectionMode: "single" | "multiple" | "none";
}

interface ListSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ListSurface({ surface, onAction }: ListSurfaceProps) {
  const data = surface.data as unknown as ListSurfaceData;
  const selectionMode = data.selectionMode ?? "none";

  // Derive selection from server data; recomputed when items change.
  const dataSelectedIds = useMemo(
    () => data.items.filter((item) => item.selected).map((item) => item.id),
    [data.items],
  );

  // Track which data reference the local overrides apply to. When data
  // changes the overrides are discarded and we fall back to dataSelectedIds.
  const [localState, setLocalState] = useState<{
    source: ListItem[];
    ids: string[];
  } | null>(null);

  const selectedIds =
    localState && localState.source === data.items
      ? localState.ids
      : dataSelectedIds;

  const handleToggle = useCallback(
    (itemId: string) => {
      if (selectionMode === "none") return;

      const prev = selectedIds;
      const next =
        selectionMode === "single"
          ? prev.includes(itemId) ? [] : [itemId]
          : prev.includes(itemId)
            ? prev.filter((id) => id !== itemId)
            : [...prev, itemId];

      setLocalState({ source: data.items, ids: next });
    },
    [selectionMode, selectedIds, data.items],
  );

  const handleAction = useCallback(
    (surfaceId: string, actionId: string, data?: Record<string, unknown>) => {
      onAction(surfaceId, actionId, { ...data, selectedIds });
    },
    [onAction, selectedIds],
  );

  const isSelectable = selectionMode !== "none";

  return (
    <SurfaceContainer surface={surface} onAction={handleAction}>
      <ul className="divide-y divide-stone-100 dark:divide-moss-600">
        {data.items.map((item) => {
          const isSelected = selectedIds.includes(item.id);

          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={!isSelectable}
                onClick={() => handleToggle(item.id)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  isSelectable
                    ? "cursor-pointer hover:bg-stone-50 dark:hover:bg-moss-600"
                    : "cursor-default"
                } ${
                  isSelected
                    ? "bg-forest-50 dark:bg-forest-950"
                    : ""
                }`}
              >
                {/* Selection indicator */}
                {isSelectable && (
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? "border-forest-600 bg-forest-600 text-white"
                        : "border-stone-300 dark:border-moss-500"
                    } ${selectionMode === "single" ? "rounded-full" : "rounded"}`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                )}

                {/* Icon */}
                {item.icon && (() => {
                  const lucideName = sfSymbolToLucideName(item.icon);
                  const LucideIcon = lucideName ? icons[lucideName as keyof typeof icons] : undefined;
                  return LucideIcon ? (
                    <LucideIcon className="h-5 w-5 shrink-0 text-[var(--content-quiet)]" aria-hidden />
                  ) : (
                    <span className="text-body-large-lighter leading-none">{item.icon}</span>
                  );
                })()}

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <span className="text-title-small text-[var(--content-strong)]">
                    {item.title}
                  </span>
                  {item.subtitle && (
                    <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
                      {item.subtitle}
                    </p>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </SurfaceContainer>
  );
}
