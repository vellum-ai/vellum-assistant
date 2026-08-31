import { useEffect, useRef } from "react";

import { openUrl } from "@/runtime/browser";
import { useIsNativeAndroid } from "@/runtime/platform-detection";

/**
 * Native Android renders the same billing surfaces as iOS but sells nothing
 * in-app: every purchase CTA hands off to the matching page on the hosted
 * web app, opened in the browser, where the full checkout flow lives.
 *
 * The Android shell's WebView loads the hosted web app itself (`server.url`
 * mode), so `window.location.origin` is the right absolute base for every
 * environment, self-hosted overrides included. `openUrl` reaches the
 * browser via the Capacitor Browser plugin; a plain in-app navigation would
 * stay inside the WebView, and a bare VIEW intent would bounce back into
 * the app because its verified App Links claim the billing routes.
 */
export function billingSiteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function openBillingPathInBrowser(path: string): void {
  void openUrl(billingSiteUrl(path));
}

/**
 * Purchase-modal handoff for native Android: when `open` flips true, opens
 * `path` in the browser instead and immediately closes the modal. Returns
 * true when the caller should render nothing (native Android).
 */
export function useAndroidBillingHandoff(args: {
  open: boolean;
  path: string;
  onClose: () => void;
}): boolean {
  const { open, path, onClose } = args;
  const isNativeAndroid = useIsNativeAndroid();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (isNativeAndroid && open) {
      openBillingPathInBrowser(path);
      onCloseRef.current();
    }
  }, [isNativeAndroid, open, path]);
  return isNativeAndroid;
}
