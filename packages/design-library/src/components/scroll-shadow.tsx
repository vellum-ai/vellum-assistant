import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../utils/cn";

export type ScrollShadowOrientation = "vertical" | "horizontal";

export interface ScrollShadowProps {
  children: ReactNode;
  /** Scroll axis the fade applies to. */
  orientation?: ScrollShadowOrientation;
  /** Fade length in pixels at each active edge. */
  size?: number;
  /** Extra scroll distance past an edge before its fade is hidden. */
  offset?: number;
  /** When false, renders a plain scroll container with no fade. */
  isEnabled?: boolean;
  /** Visually hide the scrollbar (content still scrolls). */
  hideScrollBar?: boolean;
  className?: string;
  /** Forwarded to the scroll container so callers can drive its scroll position. */
  ref?: Ref<HTMLDivElement>;
}

interface EdgeState {
  /** True when content is hidden before the visible start (top / left). */
  start: boolean;
  /** True when content is hidden past the visible end (bottom / right). */
  end: boolean;
}

/**
 * Wraps a scrollable region and fades its edges with a `mask-image` gradient,
 * signalling that more content lies above/below (or left/right). Each edge's
 * fade only shows while there is hidden content in that direction, so it
 * disappears once you reach the corresponding end.
 */
export function ScrollShadow({
  children,
  orientation = "vertical",
  size = 24,
  offset = 0,
  isEnabled = true,
  hideScrollBar = false,
  className,
  ref,
}: ScrollShadowProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<EdgeState>({ start: false, end: false });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        (ref as { current: HTMLDivElement | null }).current = node;
      }
    },
    [ref],
  );

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !isEnabled) {
      setEdges((prev) => (!prev.start && !prev.end ? prev : { start: false, end: false }));
      return;
    }
    const isVertical = orientation === "vertical";
    const pos = isVertical ? el.scrollTop : el.scrollLeft;
    const max = isVertical
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
    const start = pos > offset;
    const end = pos < max - offset;
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, [isEnabled, orientation, offset]);

  // Re-measure after every render so content changes (rows added/removed)
  // update the fades even when the container's own box size is unchanged.
  useLayoutEffect(() => {
    recompute();
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.addEventListener("scroll", recompute, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", recompute);
      observer?.disconnect();
    };
  }, [recompute]);

  const maskImage = isEnabled ? buildMask(orientation, size, edges) : undefined;

  return (
    <div
      ref={setRefs}
      data-slot="scroll-shadow"
      data-orientation={orientation}
      className={cn(
        orientation === "vertical" ? "overflow-y-auto" : "overflow-x-auto",
        hideScrollBar &&
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      style={
        maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined
      }
    >
      {children}
    </div>
  );
}

function buildMask(
  orientation: ScrollShadowOrientation,
  size: number,
  edges: EdgeState,
): string {
  const direction = orientation === "vertical" ? "to bottom" : "to right";
  const startColor = edges.start ? "transparent" : "#000";
  const endColor = edges.end ? "transparent" : "#000";
  return `linear-gradient(${direction}, ${startColor}, #000 ${size}px, #000 calc(100% - ${size}px), ${endColor})`;
}
