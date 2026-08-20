import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { isNativeIOS, isNativeMobile } from "@/runtime/platform-detection";

/**
 * Declare at the JS layer that the iOS keyboard input accessory bar (prev/next
 * chevrons plus Done) stays hidden.
 *
 * This call is not what removes the bar. `@capacitor/keyboard` sets
 * `hideFormAccessoryBar = YES` unconditionally in its native `load()`
 * (`Keyboard.m:187`, no config gate), so linking the plugin already hides the
 * bar on every native build; the call only states that intent explicitly and
 * pins it against a change to the upstream default.
 *
 * Shells without the linked plugin never run that `load()`, so they retain the
 * accessory bar and reject this call with "not implemented"; swallow so the web
 * bundle keeps working against them.
 */
export async function initNativeKeyboard(): Promise<void> {
  if (!isNativeIOS()) {
    return;
  }
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.setAccessoryBarVisible({ isVisible: false });
  } catch {
    // Plugin absent from this native build; the accessory bar remains.
  }
}

/**
 * Put the soft keyboard away through the native shell.
 *
 * Called behind a DOM blur, by the swipe-down dismiss gesture
 * (`useSwipeDownDismissKeyboard`). The blur is what dismisses the keyboard on
 * iOS; the Android WebView routinely keeps the IME up after one, and
 * `hideSoftInputFromWindow` (what the plugin calls) is the way down. That is
 * why the gate is `isNativeMobile()` and not iOS-only.
 *
 * Never throws. On Android the plugin rejects when the activity has no focused
 * view, and a shell without the plugin linked rejects with "not implemented";
 * neither is worth surfacing from a touch handler.
 *
 * `hide()` is one of the few keyboard calls iOS supports; `show()` is Android
 * only, which is why nothing here tries to put the keyboard back. Restoring it
 * is a DOM `focus()`, which the Capacitor shell allows without a gesture.
 */
export async function hideNativeKeyboard(): Promise<void> {
  if (!isNativeMobile()) {
    return;
  }
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.hide();
  } catch {
    // No focused view, or no plugin in this native build; WebKit dismisses it
    // regardless and the DOM blur is the primary path.
  }
}

/**
 * Coerce a reported keyboard height into a value layout can use.
 *
 * The bridge payload is untyped at runtime, so anything that is not a finite,
 * non-negative number falls back to `0`. iPad's QuickType bar needs no special
 * case here: the plugin already reports it as height `0`
 * (`shouldIgnoreResizeForHeight` in `Keyboard.m`).
 */
function readKeyboardHeight(reported: unknown): number {
  const height = Number(reported);
  if (!Number.isFinite(height) || height < 0) {
    return 0;
  }
  return height;
}

/**
 * Subscribe to the native keyboard height as the keyboard animation starts.
 *
 * `keyboardWillShow` fires synchronously inside the plugin's native
 * `onKeyboardWillShow`, ahead of the web view frame resize the plugin defers
 * (see `docs/CAPACITOR.md` § "Linking a plugin runs its native `load()`"), so
 * reading the height here is what lets layout follow the keyboard as it
 * animates rather than a beat after it lands. `keyboardWillHide` carries no
 * payload and means height `0`. Android announces the same pair off its window
 * insets, in CSS pixels (`Keyboard.java` divides the IME height by the display
 * density), so both shells report a height layout can use directly.
 *
 * The gate is `isNativeMobile()` because the shells that announce a keyboard
 * are exactly the shells whose web view frame the keyboard resizes, and
 * `use-visible-viewport.ts` has no other way to tell that resize apart from the
 * window itself getting shorter. In a browser the keyboard leaves
 * `window.innerHeight` alone, so there is nothing to hear from and the gate
 * returns a no-op unsubscribe with the plugin never imported.
 *
 * Show and hide are one source, so they share a single subscription: one plugin
 * import, and one warning if this shell has no keyboard plugin to give.
 *
 * `visible` says which of the two events fired, and is reported separately from
 * the height because the height is sanitized: `readKeyboardHeight` coerces a
 * malformed payload to `0`, and a show that arrives malformed still means a
 * keyboard is coming up. Reading visibility off the number instead would call
 * that a dismissal and let the frame resize behind it pass for the window
 * getting shorter.
 *
 * `onSourceReady` fires once it is settled that a soft keyboard here would
 * reach the caller: after the plugin listeners register on a native shell, and
 * straight away in a browser, where a keyboard has no frame to resize and so
 * needs no announcement to be recognised. A native shell whose registration
 * never lands (built before the plugin, or rejected) never fires it, which is
 * how `use-visible-viewport.ts` knows not to read that shell's frame resizes as
 * the window itself getting shorter. Nor does a registration the caller
 * unsubscribed from while it was still in flight: the readiness it would report
 * belongs to listeners that are already being removed.
 */
export function subscribeNativeKeyboardHeight(
  onHeightChange: (keyboardHeight: number, visible: boolean) => void,
  onSourceReady?: () => void,
): () => void {
  if (!isNativeMobile()) {
    onSourceReady?.();
    return () => {};
  }

  let cancelled = false;
  const unsubscribe = subscribeCapacitorListener(
    "native_keyboard_height",
    async () => {
      const { Keyboard } = await import("@capacitor/keyboard");
      const [show, hide] = await Promise.all([
        Keyboard.addListener("keyboardWillShow", (info) => {
          onHeightChange(readKeyboardHeight(info.keyboardHeight), true);
        }),
        Keyboard.addListener("keyboardWillHide", () => {
          onHeightChange(0, false);
        }),
      ]);
      if (!cancelled) {
        onSourceReady?.();
      }
      return {
        remove: async () => {
          await Promise.all([show.remove(), hide.remove()]);
        },
      };
    },
  );

  return () => {
    cancelled = true;
    unsubscribe();
  };
}
