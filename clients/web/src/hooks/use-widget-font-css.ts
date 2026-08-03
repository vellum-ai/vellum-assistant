/**
 * Subscribes to the inlined brand-font CSS widgets embed in their `srcdoc`.
 *
 * Returns an empty string on the first render and re-renders once — when the
 * module-level snapshot resolves — so the first widget of a session remounts
 * its iframe with fonts and every later widget gets them immediately.
 *
 * @see {@link @/utils/widget-fonts}
 */

import { useEffect, useSyncExternalStore } from "react";

import {
  ensureWidgetFontCss,
  getWidgetFontCss,
  subscribeWidgetFontCss,
} from "@/utils/widget-fonts";

export function useWidgetFontCss(): string {
  useEffect(() => {
    void ensureWidgetFontCss();
  }, []);
  return useSyncExternalStore(
    subscribeWidgetFontCss,
    getWidgetFontCss,
    () => "",
  );
}
