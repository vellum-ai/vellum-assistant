// Synchronous theme init — prevents flash-of-wrong-theme before React mounts.
// Loaded via <script src> (not inline) so CSP script-src 'self' allows it.
(function () {
  // Electron renders with the Swift macOS client's lighter type weights:
  // `.electron-type` (src/index.css) rebinds the design-library
  // `--text-*-weight` vars on <html>. Adding the class here — before any
  // stylesheet applies to rendered text — is what keeps it flash-free; if
  // React added it after mount, Electron users would see a heavy→light
  // weight flash on every launch, exactly the kind of flash this script
  // exists to prevent for the dark/light theme.
  //
  // This reads window.vellum directly even though ELECTRON.md reserves that
  // for src/runtime/ wrappers: this is a plain pre-bundle script loaded via
  // <script src> (CSP forbids inline), so it cannot import isElectron().
  // The preload bridge exposes window.vellum before any page script runs,
  // which makes the check reliable this early.
  //
  // Kept OUTSIDE the try block below deliberately: nothing on the React
  // side re-applies this class, so a blocked-storage throw in the theme
  // reads must not skip it — wrong theme self-corrects after mount, wrong
  // type weights would not.
  if (window.vellum && window.vellum.platform === "electron") {
    document.documentElement.classList.add("electron-type");
  }
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
