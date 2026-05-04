/**
 * Allowlist of known Vellum Chrome extension origins.
 *
 * Chrome extension IDs are deterministic per environment: non-production
 * builds embed a fixed public key in the manifest (injected at build time by
 * `clients/chrome-extension/build.sh`), and the production build uses the
 * stable Chrome Web Store signing key. All four IDs are therefore stable and
 * enumerable — no need for a catch-all regex.
 *
 * The canonical mapping of env → extensionId lives in:
 *   clients/chrome-extension/extension-environments.json
 *
 * If a new environment is added or an ID changes, update both files.
 *
 * Format: `chrome-extension://<id>` (the value of the HTTP Origin header sent
 * by the extension's service worker when it makes cross-origin requests to the
 * local gateway).
 */
export const KNOWN_EXTENSION_ORIGINS: ReadonlySet<string> = new Set([
  // production (Chrome Web Store)
  "chrome-extension://hphbdmpffeigpcdjkckleobjmhhokpne",
  // dev
  "chrome-extension://kajfcoaefacmjgdaloeafnpcfaeahcio",
  // staging
  "chrome-extension://idpcnibfinmkdhlpenkglianflkbhfim",
  // local
  "chrome-extension://gfcldmjjhcginboeldmknclbjilohcbn",
]);
