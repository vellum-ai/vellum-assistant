
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useState,
} from "react";

import { useDoubleClick } from "@/hooks/use-double-click";

/**
 * Bundles hover state + click/pointer handlers for interactive constellation
 * nodes. Wraps the shared `useDoubleClick` hook with pointer-down propagation
 * stop (needed to prevent canvas drag) and hover tracking for visual highlight.
 */
export function useNodeClickHandlers(
  onSingleClick?: () => void,
  onDoubleClick?: () => void,
  isSelected?: boolean,
) {
  const [isHovered, setIsHovered] = useState(false);
  const active = isHovered || isSelected === true;

  const handleClick = useDoubleClick({
    onSingleClick,
    onDoubleClick,
  });

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!onSingleClick && !onDoubleClick) return;
      event.stopPropagation();
      handleClick(event);
    },
    [onSingleClick, onDoubleClick, handleClick],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!onSingleClick && !onDoubleClick) return;
      event.stopPropagation();
    },
    [onSingleClick, onDoubleClick],
  );

  const onMouseEnter = useCallback(() => setIsHovered(true), []);
  const onMouseLeave = useCallback(() => setIsHovered(false), []);

  return { active, onClick, onPointerDown, onMouseEnter, onMouseLeave };
}
