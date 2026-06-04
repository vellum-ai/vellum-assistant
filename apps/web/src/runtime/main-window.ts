import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's main-window control
 * surface. Imperative — `ensureMainWindowVisible()` brings the main
 * window forward (recreate if destroyed, restore from minimize, show,
 * focus). Off Electron the call no-ops; web and Capacitor iOS have
 * their own foregrounding semantics (web is already the foreground
 * tab if the user is interacting; iOS handles app activation
 * natively).
 *
 * Used by feature consumers that react to inbound signals (deep
 * links, future notification action clicks) and need to accompany
 * the state update with making the window user-visible. Without
 * this, a click on `vellum://send?message=hi` on a backgrounded
 * Vellum would update composer state with no visible response.
 *
 * Same wrapper shape as `dock.ts` / `app-info.ts`: no-op off
 * Electron, awaits an IPC handler that resolves once the window
 * is loaded and focused. Safe to fire-and-forget if the caller
 * doesn't need to sequence follow-up actions.
 */

export async function ensureMainWindowVisible(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.mainWindow.ensureVisible();
}

/**
 * Switch the Electron main window between the onboarding layout (440×630
 * default, matching the macOS Swift client) and the main-app layout. Drive
 * it from the active route — `true` while an onboarding step is showing,
 * `false` otherwise.
 *
 * No-op off Electron: web is a single resizable browser viewport and
 * Capacitor iOS is system-managed, so neither has a window to resize.
 * Safe to call on every navigation — the main process treats re-asserting
 * the current mode as a no-op.
 */
export async function setOnboardingWindow(active: boolean): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.mainWindow.setOnboarding(active);
}

/**
 * Relax the Electron main window's same-origin navigation guard for the
 * duration of a sign-in, so the OAuth provider chain (WorkOS → Google/Apple →
 * our callback) runs in the main window instead of being ejected to the system
 * browser. Call immediately before starting the provider redirect; the main
 * process re-arms the guard once the flow returns to the app (or on a timeout).
 *
 * No-op off Electron — web runs OAuth as a normal top-level navigation and
 * Capacitor iOS uses the native auth sheet.
 */
export async function beginMainWindowAuthFlow(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.mainWindow.beginAuthFlow();
}
