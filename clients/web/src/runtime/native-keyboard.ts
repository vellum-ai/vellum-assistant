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
