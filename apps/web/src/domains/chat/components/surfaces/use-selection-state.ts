import { useCallback, useMemo, useState } from "react";

/**
 * Manages optimistic selection state for selectable surfaces (list, table).
 *
 * Derives initial selection from server-provided `selected` flags on items.
 * Tracks local overrides via reference-equality on the source array — when the
 * server pushes a new items array (identity changes), local overrides are
 * discarded and selection resets to whatever the server says. This prevents
 * stale optimistic state from persisting after a server round-trip confirms
 * or rejects the user's selection.
 */
export function useSelectionState<T extends { id: string; selected?: boolean }>(
  items: T[],
  selectionMode: "none" | "single" | "multiple",
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void,
): {
  selectedIds: string[];
  handleToggle: (id: string) => void;
  handleAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
} {
  const dataSelectedIds = useMemo(
    () => items.filter((item) => item.selected).map((item) => item.id),
    [items],
  );

  const [localState, setLocalState] = useState<{
    source: T[];
    ids: string[];
  } | null>(null);

  const selectedIds =
    localState && localState.source === items
      ? localState.ids
      : dataSelectedIds;

  const handleToggle = useCallback(
    (id: string) => {
      if (selectionMode === "none") return;

      const prev = selectedIds;
      const next =
        selectionMode === "single"
          ? prev.includes(id) ? [] : [id]
          : prev.includes(id)
            ? prev.filter((existing) => existing !== id)
            : [...prev, id];

      setLocalState({ source: items, ids: next });
    },
    [selectionMode, selectedIds, items],
  );

  const handleAction = useCallback(
    (surfaceId: string, actionId: string, data?: Record<string, unknown>) => {
      onAction(surfaceId, actionId, { ...data, selectedIds });
    },
    [onAction, selectedIds],
  );

  return { selectedIds, handleToggle, handleAction };
}
