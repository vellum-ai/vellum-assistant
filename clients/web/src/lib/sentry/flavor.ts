import type { BrowserOptions } from "@sentry/react";

import { capacitorFlavor } from "@/lib/sentry/flavor-capacitor";
import { reactFlavor } from "@/lib/sentry/flavor-react";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

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
 * Pick the Sentry flavor for the current runtime. The single place host-based
 * selection lives: the `@sentry/capacitor` flavor inside the iOS WKWebview,
 * the `@sentry/react` flavor for the remaining browser SDK surfaces (web +
 * Electron renderer).
 */
export function selectSentryFlavor(): SentryFlavor {
  if (isNativePlatform() && !isElectron()) return capacitorFlavor;
  return reactFlavor;
}
