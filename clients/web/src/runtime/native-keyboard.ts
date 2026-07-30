import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { isNativeIOS } from "@/runtime/platform-detection";

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
 * Subscribe to the iOS keyboard height as the keyboard animation starts.
 *
 * `keyboardWillShow` fires synchronously inside the plugin's native
 * `onKeyboardWillShow`, ahead of the web view frame resize the plugin defers
 * (see `docs/CAPACITOR.md` § "Linking a plugin runs its native `load()`"), so
 * reading the height here is what lets layout follow the keyboard as it
 * animates rather than a beat after it lands. `keyboardWillHide` carries no
 * payload and means height `0`.
 *
 * Off the native iOS shell there is no keyboard to hear from, so the gate
 * returns a no-op unsubscribe and the plugin is never imported.
 */
export function subscribeNativeKeyboardHeight(
  onHeightChange: (keyboardHeight: number) => void,
): () => void {
  if (!isNativeIOS()) {
    return () => {};
  }

  const unsubscribeShow = subscribeCapacitorListener(
    "native_keyboard_will_show",
    async () => {
      const { Keyboard } = await import("@capacitor/keyboard");
      return Keyboard.addListener("keyboardWillShow", (info) => {
        onHeightChange(readKeyboardHeight(info.keyboardHeight));
      });
    },
  );
  const unsubscribeHide = subscribeCapacitorListener(
    "native_keyboard_will_hide",
    async () => {
      const { Keyboard } = await import("@capacitor/keyboard");
      return Keyboard.addListener("keyboardWillHide", () => {
        onHeightChange(0);
      });
    },
  );

  return () => {
    unsubscribeShow();
    unsubscribeHide();
  };
}
