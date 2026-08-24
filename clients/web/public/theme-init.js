// Shell init that has to run before the app bundle does.
//
// Two jobs, neither of which can wait for React: stamping the theme so the
// first paint is not the wrong one, and localizing the boot splash's
// accessible label. Loaded via <script src> (not inline) so CSP
// script-src 'self' allows it.
(function () {
  try {
    var theme =
      window.localStorage.getItem("device:theme") ||
      window.localStorage.getItem("vellum_theme") ||
      "system";
    var prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var shouldBeDark =
      theme === "velvet" ||
      theme === "dark" ||
      (theme === "system" && prefersDark);
    var root = document.documentElement;
    root.setAttribute("data-theme", shouldBeDark ? "dark" : "light");
    root.classList.toggle("dark", shouldBeDark);
    root.classList.remove("velvet");
  } catch {
    // Theme startup is best-effort. React will apply the default later.
  }
})();

// Boot splash label.
//
// `index.html` is one static file served to every locale, so the label in the
// markup is English. This replaces it for a locale that translates the same
// string, and leaves the English default in place for everything else.
//
// Locale resolution mirrors `resolveInitialLocale()` in `src/i18n/i18n.ts`:
// the stored `device:locale` preference when it names a shipped locale, then
// the host's preferred languages matched at the full tag and again at the
// primary subtag.
//
// `LABELS` carries the translation each catalog already uses for the app's own
// generic loading label (`rootHydrateFallback.loadingAria` in
// `src/i18n/locales/<locale>/common.json`). A shipped locale whose catalog
// omits that key renders the English fallback once the app is running, so
// omitting it here keeps the splash and the app saying the same thing.
// `src/shell-metadata.test.ts` fails if the two drift.
(function () {
  var SUPPORTED_LOCALES = ["en", "es", "ru"];
  var LABELS = { es: "Cargando" };

  function resolveLocale() {
    var stored = window.localStorage.getItem("device:locale");
    if (stored && SUPPORTED_LOCALES.indexOf(stored) !== -1) {
      return stored;
    }
    var preferred = [];
    var nav = window.navigator;
    if (nav && nav.languages && nav.languages.length > 0) {
      preferred = nav.languages;
    } else if (nav && nav.language) {
      preferred = [nav.language];
    }
    for (var i = 0; i < preferred.length; i++) {
      var tag = String(preferred[i]).trim().toLowerCase();
      if (tag === "") {
        continue;
      }
      if (SUPPORTED_LOCALES.indexOf(tag) !== -1) {
        return tag;
      }
      var base = tag.split("-")[0];
      if (SUPPORTED_LOCALES.indexOf(base) !== -1) {
        return base;
      }
    }
    return "en";
  }

  try {
    var locale = resolveLocale();
    var label = LABELS[locale];
    if (!label) {
      return;
    }

    // A screen reader reads `aria-label` with the phonemes of the document's
    // `lang`, so the two have to agree. `applyDocumentLocale()` sets this
    // again from the locale i18next actually activated.
    document.documentElement.lang = locale;

    var apply = function () {
      var splash = document.getElementById("boot-splash");
      if (splash) {
        splash.setAttribute("aria-label", label);
      }
    };

    // This script runs in <head>, so the splash is not parsed yet on a cold
    // load. It is on a bfcache restore or any re-execution.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply);
    } else {
      apply();
    }
  } catch {
    // Best-effort. A failure leaves the English label the markup ships with.
  }
})();
