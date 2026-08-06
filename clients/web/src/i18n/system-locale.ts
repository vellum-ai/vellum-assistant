/**
 * Reads the host's preferred UI languages, in priority order.
 *
 * All three shells run the same SPA, so all three answer through
 * `navigator.languages`. What differs is how faithfully each host mirrors the
 * OS preference into the web view, and each has a known gap:
 *
 * - **Browser**: `navigator.languages` is the browser's own language list,
 *   which is what we want. No gap.
 *
 * - **Electron (macOS / Windows)**: the renderer is Chromium, and Chromium
 *   seeds its language list from the OS UI language at process start. The gap
 *   is that it reflects the *UI language*, not a regional-format-only override
 *   (macOS "Region" set to Spain while the UI stays English), and it is
 *   sampled once at launch, so a locale change mid-session is not observed.
 *   Closing that means reading `app.getPreferredSystemLanguages()` in the main
 *   process and exposing it over the `window.vellum` bridge. See
 *   `docs/ELECTRON.md` for the three-file bridge pattern. Deferred: it needs
 *   preload + main + contract changes, and the launch-time value is correct
 *   for the overwhelming majority of users.
 *
 * - **Capacitor (iOS / Android)**: the WKWebView / Android WebView reports
 *   the *system* language. The gap is iOS's per-app language setting
 *   (Settings → Vellum → Preferred Language, iOS 13+): a user who sets only
 *   this app to Spanish while the phone stays English still gets `en` here.
 *   Closing that means `Device.getLanguageTag()` from `@capacitor/device`,
 *   which reads `Locale.preferredLanguages` and so sees the per-app choice.
 *   Deferred: adding an iOS Capacitor plugin is not runtime-neutral. Its
 *   native `load()` runs at bridge init whether or not JS imports it, and
 *   `docs/CAPACITOR.md` requires auditing that before taking the dependency.
 *
 * Until those land, the explicit in-app preference (`device:locale`, written
 * by `changeLocale()`) is the escape hatch for every one of these gaps: it is
 * consulted first and overrides whatever the host reports.
 *
 * References:
 * - https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages
 * - https://www.electronjs.org/docs/latest/api/app#appgetpreferredsystemlanguages
 * - https://capacitorjs.com/docs/apis/device#getlanguagetag
 */

/**
 * The host's preferred languages as BCP 47 tags, most-preferred first.
 *
 * Returns an empty array when there is no `navigator` (SSR, non-DOM test
 * contexts) so callers fall through to their own default.
 */
export function systemLocales(): string[] {
  if (typeof navigator === "undefined") {
    return [];
  }

  // `navigator.languages` is the full ordered preference list. Safari and some
  // WebViews have historically left it empty or absent, so `navigator.language`
  // (always present) is the single-entry fallback.
  const languages = navigator.languages;
  if (Array.isArray(languages) && languages.length > 0) {
    return [...languages];
  }

  return navigator.language ? [navigator.language] : [];
}
