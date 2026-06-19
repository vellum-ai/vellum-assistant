import type { BrowserOptions } from "@sentry/react";

import { reactFlavor } from "@/lib/sentry/flavor-react";

/**
 * A thin seam over the Sentry SDK so consent gating in `sentry-control.ts`
 * can dispatch through a single interface instead of importing a concrete
 * SDK directly. Each surface (web/electron renderer, capacitor) provides its
 * own implementation; `selectSentryFlavor()` picks the right one at runtime.
 */
export interface SentryFlavor {
  /** Initialize the SDK with the given options (enabling the client). */
  init(options: BrowserOptions): void;
  /** Tear down the active client, if any. */
  close(): Promise<void> | void;
  /** Whether an enabled client is currently installed. */
  getClientEnabled(): boolean;
}

/**
 * Pick the Sentry flavor for the current runtime.
 *
 * For now this always returns the `@sentry/react` flavor — the only surface
 * shipping the browser SDK today (web + Electron renderer). Later PRs add
 * branches here for the Electron renderer (IPC bridge) and the Capacitor
 * native platform; insert those `isElectron()` / `isNativePlatform()` checks
 * above the react fallback.
 */
export function selectSentryFlavor(): SentryFlavor {
  return reactFlavor;
}
