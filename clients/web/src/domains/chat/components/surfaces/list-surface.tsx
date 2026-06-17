import { Check } from "lucide-react";

import { sfSymbolToLucideIcon } from "@/domains/chat/components/surfaces/sf-symbol-map";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useSelectionState } from "@/domains/chat/components/surfaces/use-selection-state";
import type { Surface } from "@/domains/chat/types/types";

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
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  isSelectable
                    ? "cursor-pointer hover:bg-[var(--surface-hover)]"
                    : "cursor-default"
                } ${
                  isSelected
                    ? "bg-[var(--system-positive-weak)]"
                    : ""
                }`}
              >
                {/* Selection indicator */}
                {isSelectable && (
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
                        : "border-[var(--border-element)]"
                    } ${selectionMode === "single" ? "rounded-full" : "rounded"}`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                )}

                {/* Icon */}
                {item.icon && (() => {
                  const LucideIcon = sfSymbolToLucideIcon(item.icon);
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
