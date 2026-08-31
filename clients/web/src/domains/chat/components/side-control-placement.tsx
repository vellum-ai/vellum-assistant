/**
 * Decides, for one chat column, whether the side controls can float in its
 * right gutter or have to fall back to the row above the composer.
 *
 * The answer has to be shared, not computed twice. The controls mount in two
 * places (floating at the top of the column, and in flow above the composer)
 * and exactly one may draw. Measuring independently in each would let them
 * disagree for a frame and render the cluster twice, or neither. So the column
 * measures once, here, and both mounts read the same value.
 *
 * Context rather than a store because the question is scoped to a column: the
 * pop-out window and the app-editing split each have their own, and a global
 * flag would make one answer for all of them. Consumers outside a boundary get
 * `false`, which is the safe default: the composer row always fits.
 */

import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from "react";

import { useSideControlsFitGutter } from "@/domains/chat/hooks/use-side-control-placement";

const FitsGutterContext = createContext(false);

/**
 * Whether this column can float the controls in its gutter. `false` means they
 * belong above the composer instead.
 */
export function useSideControlsFitGutterValue(): boolean {
  return useContext(FitsGutterContext);
}

/**
 * The chat column, measured. Renders a plain element with `className`, so it
 * replaces the wrapper the column already had rather than nesting another box
 * inside it.
 */
export function SideControlPlacementBoundary({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fitsGutter = useSideControlsFitGutter(ref);
  return (
    <div ref={ref} className={className}>
      <FitsGutterContext.Provider value={fitsGutter}>
        {children}
      </FitsGutterContext.Provider>
    </div>
  );
}
