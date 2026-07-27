import { isNativeIOS } from "@/runtime/platform-detection";

/**
 * Skew-safe seam for every JS → native call that supports iOS voice mode.
 *
 * **The skew contract.** The iOS app is a Capacitor `server.url` shell: it
 * bundles no web assets and navigates `WKWebView` straight at the deployed web
 * origin at launch (`clients/ios/README.md` § "Web content delivery"). So this
 * bundle deploys continuously and is live for every iOS user on their next app
 * load, while the shell that hosts it only changes after an App Store review
 * cycle. At any moment an arbitrarily old shell can be running an arbitrarily
 * new bundle. Every call site must therefore assume the native plugin it wants
 * does not exist, and must degrade to a working voice session without it —
 * a missing bridge may cost a native flourish (a Live Activity, an audio
 * session hint) but must never fail, block, or end the session itself.
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
 * @param fallback Returned off-iOS and on any bridge failure. Must be a value
 *   the caller can proceed with.
 */
export async function callNativeVoice<T>(
  invoke: () => Promise<T>,
  fallback: T,
): Promise<T> {
  // Platform short-circuit, cited per `docs/CAPACITOR.md` § "Platform
  // short-circuits in capability detection". The constraint here is not a
  // broken web API but the absence of a host: these bridges are custom
  // Capacitor plugins compiled into the iOS shell (`clients/ios/README.md`
  // § "Web content delivery"), so in a browser, in Electron, or in a
  // Capacitor Android runtime there is no native side to call and no feature
  // probe that could find one. Invalidated if an equivalent plugin ever ships
  // in another shell — widen the gate then.
  if (!isNativeIOS()) {
    return fallback;
  }
  try {
    return await invoke();
  } catch (err) {
    // Deliberately `console.debug`, not the `captureError` that
    // `docs/CONVENTIONS.md` § "Manual error reporting from imperative code"
    // otherwise prescribes: an older App Store shell without the plugin is an
    // expected state on every web deploy, not a fault, and reporting it would
    // spam Sentry once per skewed install.
    console.debug("[native-voice] bridge call unavailable:", err);
    return fallback;
  }
}
