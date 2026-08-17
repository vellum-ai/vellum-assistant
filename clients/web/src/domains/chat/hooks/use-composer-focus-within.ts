import { type RefObject, useEffect, useState } from "react";

/**
 * Whether focus currently sits inside `containerRef`.
 *
 * Listeners are bound on `document`, not the container, for the same reason
 * `ComposerPeek` does it: the composer subtree remounts (a draft conversation
 * settling, the textarea re-keying) and node-level handlers would go with it.
 * Focus moving between children of the container is not a leave, so only a
 * landing spot outside the container clears the flag.
 *
 * `focusout` with a null `relatedTarget` counts as leaving: that is focus
 * returning to the body, which is how the iOS keyboard dismiss arrives.
 */
export function useComposerFocusWithin(
  containerRef: RefObject<HTMLElement | null>,
): boolean {
  const [focusWithin, setFocusWithin] = useState(false);

  useEffect(() => {
    const isInside = (node: EventTarget | null): boolean => {
      return (
        node instanceof Node && (containerRef.current?.contains(node) ?? false)
      );
    };

    const onFocusIn = (event: FocusEvent) => {
      setFocusWithin(isInside(event.target));
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!isInside(event.relatedTarget)) {
        setFocusWithin(false);
      }
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    // The composer may already hold focus when this mounts (a fresh chat
    // autofocuses it), so seed from the current state instead of waiting for a
    // focus round-trip.
    setFocusWithin(isInside(document.activeElement));

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [containerRef]);

  return focusWithin;
}
