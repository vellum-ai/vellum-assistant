import { type CSSProperties, type ReactNode, type Ref, useCallback } from "react";

import {
  type ScrollAxis,
  type ScrollFadeEdges,
  scrollEdgeMask,
  useScrollEdges,
} from "../hooks/use-scroll-edges";
import { assignRef } from "../utils/assign-ref";
import { cn } from "../utils/cn";

export type ScrollShadowOrientation = ScrollAxis;

/** Which edges fade: both, only the start (top / left), or only the end. */
export type ScrollShadowFadeEdges = ScrollFadeEdges;

export interface ScrollShadowProps {
  children: ReactNode;
  /** Scroll axis the fade applies to. */
  orientation?: ScrollShadowOrientation;
  /** Fade length in pixels at each active edge. */
  size?: number;
  /** Extra scroll distance past an edge before its fade is hidden. */
  offset?: number;
  /** Which edges fade when they have hidden content past them. */
  fadeEdges?: ScrollShadowFadeEdges;
  /** When false, renders a plain scroll container with no fade. */
  isEnabled?: boolean;
  /** Visually hide the scrollbar (content still scrolls). */
  hideScrollBar?: boolean;
  className?: string;
  /** Forwarded to the scroll container so callers can drive its scroll position. */
  ref?: Ref<HTMLDivElement>;
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
  fadeEdges = "both",
  isEnabled = true,
  hideScrollBar = false,
  className,
  ref,
}: ScrollShadowProps) {
  const { ref: measureRef, edges } = useScrollEdges<HTMLDivElement>(
    orientation,
    { offset, enabled: isEnabled },
  );

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node);
      assignRef(ref, node);
    },
    [measureRef, ref],
  );

  const maskImage = isEnabled
    ? scrollEdgeMask(orientation, size, edges, fadeEdges)
    : undefined;

  // The scrollbar is hidden with an inline property as well as the utility
  // classes. An app that consumes this package as source does not necessarily
  // generate those classes (Tailwind scans the app's own files, not a linked
  // package), and an inline `scrollbar-width` outranks any app-level rule
  // that sets one on every element. The `::-webkit-scrollbar` rule has no
  // inline form, so its class stays for the engines that still need it.
  const style: CSSProperties = {
    ...(maskImage ? { maskImage, WebkitMaskImage: maskImage } : {}),
    ...(hideScrollBar ? { scrollbarWidth: "none" } : {}),
  };

  return (
    <div
      ref={setRefs}
      data-slot="scroll-shadow"
      data-orientation={orientation}
      className={cn(
        orientation === "vertical" ? "overflow-y-auto" : "overflow-x-auto",
        hideScrollBar && "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      <div className={orientation === "horizontal" ? "w-max" : undefined}>
        {children}
      </div>
    </div>
  );
}
