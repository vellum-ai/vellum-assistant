import { isNativeIOS } from "@/runtime/platform-detection";

/**
 * Read `detail.keyboardHeight` off a native `keyboardWillShow` event.
 *
 * The plugin formats the payload as an object-literal string that the bridge
 * evaluates, so an absent or malformed `detail` is possible; anything that is
 * not a finite, non-negative number falls back to `0`. iPad's QuickType bar
 * needs no special case here: the plugin already reports it as height `0`
 * (`shouldIgnoreResizeForHeight` in `Keyboard.m`).
 */
function readKeyboardHeight(event: Event): number {
  const { detail } = event as CustomEvent<unknown>;
  if (typeof detail !== "object" || detail === null) {
    return 0;
  }
  const height = Number((detail as { keyboardHeight?: unknown }).keyboardHeight);
  if (!Number.isFinite(height) || height < 0) {
    return 0;
  }
  return height;
}

/**
 * Subscribe to the iOS keyboard height as the keyboard animation starts.
 *
 * `@capacitor/keyboard` dispatches `keyboardWillShow` and `keyboardWillHide` on
 * `window` from its native keyboard observers
 * (`triggerWindowJSEventWithEventName`). `keyboardWillShow` fires synchronously
 * inside `onKeyboardWillShow`, before the plugin's own webview resize, which it
 * defers by the keyboard animation duration plus 0.2s. Reading the height here
 * is what lets layout follow the keyboard as it animates rather than a beat
 * after it lands. `keyboardWillHide` carries no payload and means height `0`.
 *
 * These are plain window events, so the module needs no `@capacitor/keyboard`
 * import and stays synchronous. Off the native iOS shell the events never fire;
 * gating on {@link isNativeIOS} states that intent and guarantees no listener is
 * attached in mobile Safari.
 */
export function subscribeNativeKeyboardHeight(
  onHeightChange: (keyboardHeight: number) => void,
): () => void {
  if (!isNativeIOS()) {
    return () => {};
  }

  const handleWillShow = (event: Event) => {
    onHeightChange(readKeyboardHeight(event));
  };
  const handleWillHide = () => {
    onHeightChange(0);
  };

  window.addEventListener("keyboardWillShow", handleWillShow);
  window.addEventListener("keyboardWillHide", handleWillHide);

  return () => {
    window.removeEventListener("keyboardWillShow", handleWillShow);
    window.removeEventListener("keyboardWillHide", handleWillHide);
  };
}
