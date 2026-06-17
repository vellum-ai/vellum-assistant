/**
 * Native HTML5 drag-and-drop reordering for vertical lists.
 *
 * Generic over the item type so any sidebar section can opt in. Each
 * reorderable list passes a stable `section` key; drags only land within
 * the section they started in, so a pinned row can't be dropped into a
 * custom group (cross-section moves stay an explicit menu action).
 *
 * Uses the platform drag events (no library) — `PanelItem` forwards
 * unknown props to its row element, so callers spread
 * `getItemProps(...)` straight onto it. Touch devices don't fire HTML5
 * drag events, so this is a no-op there; pointer-based reordering on
 * iOS would need a dedicated gesture layer.
 *
 * References:
 * - https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
 */

import { useRef, useState, type DragEvent } from "react";

export type DropEdge = "before" | "after";

export interface DropIndicator {
  section: string;
  itemId: string;
  edge: DropEdge;
}

export interface DragReorderItemProps {
  draggable: true;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/**
 * Pure reorder computation: the list after dropping `sourceId` on the
 * `edge` of `targetId`. Returns `null` when the drop is a no-op (source
 * dropped on itself, ids missing from the list, or the resulting order
 * is unchanged) so callers can skip the mutation entirely.
 */
export function reorderByDrop<T>(
  items: readonly T[],
  getId: (item: T) => string,
  sourceId: string,
  targetId: string,
  edge: DropEdge,
): T[] | null {
  if (sourceId === targetId) return null;
  const source = items.find((item) => getId(item) === sourceId);
  if (!source) return null;
  const without = items.filter((item) => getId(item) !== sourceId);
  const targetIndex = without.findIndex((item) => getId(item) === targetId);
  if (targetIndex === -1) return null;
  const insertAt = edge === "before" ? targetIndex : targetIndex + 1;
  const next = [
    ...without.slice(0, insertAt),
    source,
    ...without.slice(insertAt),
  ];
  if (next.every((item, i) => item === items[i])) return null;
  return next;
}

function edgeFromPointer(event: DragEvent<HTMLElement>): DropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export interface UseDragReorderResult<T> {
  /**
   * Drag handlers for one row. `items` is the section's full ordered
   * list (not a paginated slice) — the drop result is computed from it.
   */
  getItemProps: (section: string, items: T[], item: T) => DragReorderItemProps;
  /** Id of the row currently being dragged, for dimming styles. */
  draggingId: string | null;
  /** Row + edge the pointer is hovering, for the insertion-line style. */
  dropIndicator: DropIndicator | null;
}

export function useDragReorder<T>({
  getId,
  onReorder,
}: {
  getId: (item: T) => string;
  onReorder: (section: string, ordered: T[]) => void;
}): UseDragReorderResult<T> {
  // The active drag lives in a ref (read synchronously by other rows'
  // dragover handlers); `draggingId` mirrors it as state for styling.
  const activeDragRef = useRef<{ section: string; itemId: string } | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );

  const clearDrag = () => {
    activeDragRef.current = null;
    setDraggingId(null);
    setDropIndicator(null);
  };

  const getItemProps = (
    section: string,
    items: T[],
    item: T,
  ): DragReorderItemProps => {
    const itemId = getId(item);
    return {
      draggable: true,
      onDragStart: (event) => {
        activeDragRef.current = { section, itemId };
        event.dataTransfer.effectAllowed = "move";
        // Firefox won't start a drag without payload data.
        event.dataTransfer.setData("text/plain", itemId);
        // Defer the style flip past dragstart — re-rendering the dragged
        // node inside the dragstart dispatch cancels the drag in Chromium.
        window.setTimeout(() => {
          if (activeDragRef.current?.itemId === itemId) setDraggingId(itemId);
        }, 0);
      },
      onDragOver: (event) => {
        const drag = activeDragRef.current;
        if (!drag || drag.section !== section) return;
        // preventDefault marks this row as a valid drop target.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (drag.itemId === itemId) {
          setDropIndicator(null);
          return;
        }
        const edge = edgeFromPointer(event);
        setDropIndicator((prev) =>
          prev?.section === section &&
          prev.itemId === itemId &&
          prev.edge === edge
            ? prev
            : { section, itemId, edge },
        );
      },
      onDragLeave: (event) => {
        // dragleave also fires when entering a child element of the row.
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDropIndicator((prev) => (prev?.itemId === itemId ? null : prev));
      },
      onDrop: (event) => {
        const drag = activeDragRef.current;
        if (!drag || drag.section !== section) return;
        event.preventDefault();
        const next = reorderByDrop(
          items,
          getId,
          drag.itemId,
          itemId,
          edgeFromPointer(event),
        );
        clearDrag();
        if (next) onReorder(section, next);
      },
      onDragEnd: clearDrag,
    };
  };

  return { getItemProps, draggingId, dropIndicator };
}
