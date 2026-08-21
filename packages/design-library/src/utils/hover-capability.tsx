/**
 * The input-capability signal for affordances that only hover can reveal.
 *
 * `hover` is independent of `pointer` and of viewport width, so it is the only
 * axis that answers whether a hover-revealed surface is reachable at all: an
 * iPad in landscape reports `hover: none` at 1024px, and a desktop window
 * narrowed to 600px keeps its mouse. This is the same question the reveal rules
 * in `tokens.css` ask, so a component deciding in TypeScript whether to mount a
 * hover-only surface and the CSS deciding whether to paint one stay in
 * agreement. `hover-capability.test.ts` parses those blocks and fails if the
 * two drift.
 *
 * The query is the negative one, and that is deliberate. A surface is treated as
 * hover-capable unless the device affirmatively reports that it cannot hover, so
 * every environment that does not evaluate media features at all (server
 * rendering, a test DOM, a stub that answers `false` to everything) keeps the
 * hover behaviour rather than losing it. Failing the other way would silently
 * strip tooltips wherever the signal is merely unknown, which is a far larger
 * blast radius than leaving one on a device that turns out not to want it.
 *
 * `hover`, not `any-hover`, and that is also deliberate. `any-hover: hover`
 * matches whenever any input mechanism can hover, so a hovering stylus (an
 * S-Pen, a Pencil) flips it on a screen whose primary input is still a finger,
 * and the affordance comes back for the very input it fails on. The primary
 * axis under-serves a tablet with a mouse attached; the any axis mis-serves
 * every finger on a stylus-capable screen, the larger and worse failure. It
 * also keeps this constant on the same axis as the `hover` blocks in
 * `tokens.css` that the parity test guards.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 */

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export const HOVER_ABSENT_MEDIA_QUERY = "(hover: none)";

const HoverCapabilityOverrideContext = createContext<boolean | null>(null);

export interface HoverCapabilityOverrideProps {
  /** What {@link useHoverCapable} answers inside this subtree. */
  hoverCapable: boolean;
  children: ReactNode;
}

/**
 * Subtree-scoped answer for {@link useHoverCapable}, for a story or a test
 * that shows the no-hover presentation. Scoped through context rather than a
 * swapped `matchMedia` because that global is sampled by everything mounted
 * alongside: on a Storybook autodocs page every canvas renders together, and
 * a global swap makes the ordinary stories misrepresent the browser they are
 * actually in. Production code reads the device and does not mount this.
 */
export function HoverCapabilityOverride({
  hoverCapable,
  children,
}: HoverCapabilityOverrideProps) {
  return (
    <HoverCapabilityOverrideContext.Provider value={hoverCapable}>
      {children}
    </HoverCapabilityOverrideContext.Provider>
  );
}

/**
 * Whether the device's primary input can hover (see
 * {@link HOVER_ABSENT_MEDIA_QUERY}). Re-renders when the platform re-evaluates
 * the feature, though whether attaching a mouse flips it is the platform's
 * call: Android promotes the mouse to primary input, iPadOS keeps reporting
 * touch.
 *
 * Prefer letting a primitive read this over reading it in a caller: a caller
 * that drops its own tooltip on touch is re-deciding a question every caller
 * answers the same way.
 */
export function useHoverCapable(): boolean {
  const override = useContext(HoverCapabilityOverrideContext);

  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(HOVER_ABSENT_MEDIA_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const getSnapshot = useCallback(
    () => !window.matchMedia(HOVER_ABSENT_MEDIA_QUERY).matches,
    [],
  );

  const capable = useSyncExternalStore(subscribe, getSnapshot, () => true);
  return override ?? capable;
}
