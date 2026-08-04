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
  '[data-slot="active-overlay-panel"][data-state="open"]',
  '[role="dialog"]',
].join(",");

const ACTIVE_CHAT_SELECTOR = '[data-slot="active-chat-view"]';

function wasLayerDismissed(
  layer: HTMLElement,
  event: KeyboardEvent,
): boolean {
  if (event.defaultPrevented || !layer.isConnected) {
    return true;
  }
  const state = layer.getAttribute("data-state");
  return state !== null && state !== "open";
}

function getLayerEscapeTarget(layer: HTMLElement): HTMLElement {
  if (layer.dataset.slot !== "dropdown-menu" || !layer.id) {
    return layer;
  }

  const triggers = document.querySelectorAll<HTMLElement>(
    '[data-slot="dropdown-trigger"][aria-controls]',
  );
  for (const trigger of triggers) {
    if (trigger.getAttribute("aria-controls") === layer.id) {
      return trigger;
    }
  }
  return layer;
}

function dispatchEscape(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function getTopEscapeLayer(
  layers: NodeListOf<HTMLElement>,
): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const controlledId = active.getAttribute("aria-controls");
    if (controlledId) {
      for (const layer of layers) {
        if (layer.id === controlledId) {
          return layer;
        }
      }
    }
  }
  const focusedLayer =
    active instanceof Element
      ? active.closest<HTMLElement>(OPEN_LAYER_SELECTOR)
      : null;
  return focusedLayer ?? layers.item(layers.length - 1);
}

async function dismissEscapeLayer(): Promise<boolean> {
  const layers = document.querySelectorAll<HTMLElement>(OPEN_LAYER_SELECTOR);
  const layer = getTopEscapeLayer(layers);
  if (!layer) {
    const target = document.activeElement ?? document.body;
    return dispatchEscape(target).defaultPrevented;
  }

  const event = dispatchEscape(getLayerEscapeTarget(layer));

  if (wasLayerDismissed(layer, event)) {
    return true;
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  return true;
}

function dismissViewerLayer(): boolean {
  if (!document.querySelector(ACTIVE_CHAT_SELECTOR)) {
    return false;
  }
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
    let handlingBack = false;
    const handleBack = async (canGoBack: boolean): Promise<void> => {
      if ((await dismissEscapeLayer()) || dismissViewerLayer()) {
        return;
      }
      if (canGoBack) {
        window.history.back();
        return;
      }
      await App.minimizeApp().catch((error) => {
        captureError(error, {
          context: "android_back_minimize",
          level: "warning",
        });
      });
    };
    return App.addListener("backButton", ({ canGoBack }) => {
      if (handlingBack) {
        return;
      }
      handlingBack = true;
      void handleBack(canGoBack).finally(() => {
        handlingBack = false;
      });
    });
  });
}
