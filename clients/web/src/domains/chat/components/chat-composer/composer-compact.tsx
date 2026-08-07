import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * Composer card width (px) below which the action row can no longer hold the
 * labelled access + model-profile triggers side by side: they run into each
 * other and the two labels render on top of one another. Below this the pair
 * collapses into a single hamburger menu holding both sections.
 *
 * Measured against the card, not the viewport: the composer also narrows when
 * the sidebar opens or the window is split, and the collision follows the card.
 */
export const COMPOSER_COMPACT_WIDTH_PX = 520;

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
 * {@link COMPOSER_COMPACT_WIDTH_PX}, via `ResizeObserver` so it follows
 * sidebar toggles and window resizes, not just the initial layout.
 */
export function useIsCompactComposerWidth(
  ref: RefObject<HTMLElement | null>,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      setCompact(el.getBoundingClientRect().width < COMPOSER_COMPACT_WIDTH_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return compact;
}
