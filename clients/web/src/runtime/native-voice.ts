import { isNativeMobile } from "@/runtime/platform-detection";

/**
 * Skew-safe seam for optional native voice calls in either mobile shell.
 *
 * The web bundle can be newer than the installed iOS or Android shell. Every
 * call therefore assumes the requested plugin may be absent and falls back
 * without blocking or ending voice.
 *
 * Route every native voice call through {@link callNativeVoice}. This module
 * stays deliberately plugin-agnostic: it neither calls `registerPlugin` nor
 * imports any `@capacitor/*` package. Plugin registration and the inline
 * destructuring required by `docs/CAPACITOR.md` § "Capacitor plugins must be
 * destructured inline" live in each plugin's own module.
 */

/**
 * Run a native voice bridge call, resolving to `fallback` whenever the bridge
 * is unavailable or fails. Never throws and never rejects.
 *
 * @param invoke Performs the bridge call. Destructure the plugin inline here —
 *   never let a plugin Proxy cross an `async` return.
 * @param fallback Returned outside a native mobile shell and on bridge failure.
 */
export async function callNativeVoice<T>(
  invoke: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!isNativeMobile()) {
    return fallback;
  }
  try {
    return await invoke();
  } catch (err) {
    // Missing plugins are expected while installed shells catch up to the web.
    console.debug("[native-voice] bridge call unavailable:", err);
    return fallback;
  }
}

type NativeVoiceListenerHandle = { remove(): Promise<void> };

export function subscribeNativeVoiceListener(
  register: () => Promise<NativeVoiceListenerHandle>,
  failureContext: string,
): () => void {
  if (!isNativeMobile()) {
    return () => undefined;
  }

  let handle: NativeVoiceListenerHandle | null = null;
  let cancelled = false;

  try {
    void register().then(
      (registered) => {
        if (cancelled) {
          void registered.remove();
        } else {
          handle = registered;
        }
      },
      (err: unknown) => {
        console.debug(`[${failureContext}] listener unavailable:`, err);
      },
    );
  } catch (err) {
    console.debug(`[${failureContext}] listener unavailable:`, err);
    return () => undefined;
  }

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
