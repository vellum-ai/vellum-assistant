import { captureError } from "@/lib/sentry/capture-error";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { isNativeAndroid } from "@/runtime/platform-detection";
import { useViewerStore } from "@/stores/viewer-store";

const OPEN_LAYER_SELECTOR = [
  '[data-slot="modal-content"][data-state="open"]',
  '[data-slot="bottom-sheet-content"][data-state="open"]',
  '[data-slot="menu-content"][data-state="open"]',
  '[data-slot="menu-sub-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="context-menu-sub-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="dropdown-menu"]',
  '[role="dialog"]',
].join(",");

function dismissOpenLayer(): boolean {
  if (!document.querySelector(OPEN_LAYER_SELECTOR)) {
    return false;
  }

  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}

function dismissViewerLayer(): boolean {
  const viewer = useViewerStore.getState();
  switch (viewer.mainView) {
    case "app":
      if (viewer.isAppMinimized) {
        viewer.closeApp();
      } else {
        viewer.minimizeApp();
      }
      return true;
    case "app-editing":
      viewer.exitAppEditing();
      return true;
    default:
      return viewer.closeActiveOverlay();
  }
}

/**
 * Route Android system Back through the active web UI before leaving the app.
 */
export function subscribeAndroidBackButtonSource(): () => void {
  if (!isNativeAndroid()) {
    return () => undefined;
  }

  return subscribeCapacitorListener("android_back_button", async () => {
    const { App } = await import("@capacitor/app");
    return App.addListener("backButton", ({ canGoBack }) => {
      if (dismissOpenLayer() || dismissViewerLayer()) {
        return;
      }
      if (canGoBack) {
        window.history.back();
        return;
      }
      void App.minimizeApp().catch((error) => {
        captureError(error, {
          context: "android_back_minimize",
          level: "warning",
        });
      });
    });
  });
}
