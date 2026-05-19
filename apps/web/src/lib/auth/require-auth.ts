/**
 * Runtime auth requirement check.
 *
 * Returns `true` when the app should enforce authentication (redirect
 * unauthenticated users to login). Returns `false` when auth is
 * optional (local development, self-hosting, future Electron/macOS).
 *
 * Controlled by the `VITE_AUTH_REQUIRED` environment variable:
 * - `"true"` → auth enforced (set by hosted deployments and App Store builds)
 * - anything else / unset → auth optional (default for local dev / self-hosting)
 *
 * References:
 * - https://vite.dev/guide/env-and-mode.html
 */
export function requiresAuth(): boolean {
  return import.meta.env.VITE_AUTH_REQUIRED === "true";
}
