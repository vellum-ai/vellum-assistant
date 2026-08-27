import { createContext, useContext, type ReactNode } from "react";

import { COMPACT_WIDTH_PX, useIsCompactWidth } from "@/hooks/use-compact-width";

/**
 * Composer card width (px) below which the action row can no longer hold the
 * labelled access + model-profile triggers side by side: they run into each
 * other and the two labels render on top of one another. Below this the pair
 * collapses into a single hamburger menu holding both sections.
 *
 * This is the tightest surface in the chat column, so it is what sets the
 * column's shared threshold.
 */
export const COMPOSER_COMPACT_WIDTH_PX = COMPACT_WIDTH_PX;

const ComposerCompactContext = createContext(false);

/**
 * True while the composer this control sits in is too narrow for labelled
 * triggers. Read by the controls themselves (they own how they shrink);
 * `ChatComposer` owns the measurement and which slots stay mounted.
 */
export function useComposerCompact(): boolean {
  return useContext(ComposerCompactContext);
}

export function ComposerCompactProvider({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <ComposerCompactContext.Provider value={compact}>
      {children}
    </ComposerCompactContext.Provider>
  );
}

/**
 * Track whether `ref`'s element is narrower than
 * {@link COMPOSER_COMPACT_WIDTH_PX}.
 */
export const useIsCompactComposerWidth = useIsCompactWidth;
