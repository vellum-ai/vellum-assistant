/**
 * The size of the window a layer is drawing in, as its own pixels.
 *
 * Shared by the layers on the companion's frame window, which is sized by the
 * macOS shell to exactly the surface a call is being shown. Everything drawn
 * there is described in fractions of that surface, so the box is what turns
 * a fraction into somewhere to draw and what decides whether something fits.
 */

import { useEffect, useState } from "react";

export interface WindowBox {
  width: number;
  height: number;
}

export function useWindowBox(): WindowBox {
  const [box, setBox] = useState<WindowBox>(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  useEffect(() => {
    // The shell resizes this window whenever the share moves to another
    // target, and follows a picked window as the user drags it, so the box is
    // not something that can be read once.
    const measure = (): void => {
      setBox({ width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, []);
  return box;
}
