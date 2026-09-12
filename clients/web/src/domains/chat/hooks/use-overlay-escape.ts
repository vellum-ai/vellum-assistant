import { useEffect } from "react";

/** Offers unclaimed Escape to the active overlay, including Android Back. */
export function useOverlayEscape(enabled: boolean, dismiss: () => boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (dismiss()) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, dismiss]);
}
