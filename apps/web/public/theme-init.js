// Synchronous theme init — prevents flash-of-wrong-theme before React mounts.
// Loaded via <script src> (not inline) so CSP script-src 'self' allows it.
(function () {
  // Electron renders with the Swift macOS client's lighter type weights
  // (see `.electron-type` in src/index.css). The preload script exposes
  // window.vellum before any page script runs, so this is flash-free.
  // Outside the try block: nothing on the React side re-applies this class,
  // so a blocked-storage throw below must not skip it.
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
