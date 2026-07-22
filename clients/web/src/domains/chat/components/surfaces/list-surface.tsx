import {
  type ListSurfaceData,
  ListSurfaceDataSchema,
} from "@vellumai/assistant-api";
import { useMemo } from "react";

import { SelectionIndicator } from "@/domains/chat/components/surfaces/selection-indicator";
import { sfSymbolToLucideIcon } from "@/domains/chat/components/surfaces/sf-symbol-map";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useSelectionState } from "@/domains/chat/components/surfaces/use-selection-state";
import type { Surface } from "@/domains/chat/types/types";
import { cn } from "@/utils/misc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ListSurface({ surface, onAction }: ListSurfaceProps) {
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface. Memoized on the payload
  // identity because `useSelectionState` keys its optimistic overrides on the
  // items array's reference.
  const data = useMemo<ListSurfaceData>(() => {
    const parsed = ListSurfaceDataSchema.safeParse(surface.data);
    return parsed.success ? parsed.data : { items: [], selectionMode: "none" };
  }, [surface.data]);
  const selectionMode = data.selectionMode;

  const { selectedIds, handleToggle, handleAction } = useSelectionState(
    data.items,
    selectionMode,
    onAction,
  );

  const isSelectable = selectionMode !== "none";

  return (
    <SurfaceContainer surface={surface} onAction={handleAction}>
      <ul className="divide-y divide-[var(--border-base)]">
        {data.items.map((item) => {
          const isSelected = selectedIds.includes(item.id);

          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={!isSelectable}
                onClick={() => handleToggle(item.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  isSelectable
                    ? "cursor-pointer hover:bg-[var(--surface-hover)]"
                    : "cursor-default",
                  isSelected ? "bg-[var(--system-positive-weak)]" : "",
                )}
              >
                {/* Selection indicator */}
                {isSelectable && (
                  <SelectionIndicator
                    selected={isSelected}
                    single={selectionMode === "single"}
                  />
                )}

                {/* Icon */}
                {item.icon &&
                  (() => {
                    const LucideIcon = sfSymbolToLucideIcon(item.icon);
                    return LucideIcon ? (
                      <LucideIcon
                        className="h-5 w-5 shrink-0 text-[var(--content-quiet)]"
                        aria-hidden
                      />
                    ) : (
                      <span className="text-body-large-lighter leading-none">
                        {item.icon}
                      </span>
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
