import type { BrowserOptions } from "@sentry/react";

import { capacitorFlavor } from "@/lib/sentry/flavor-capacitor";
import { reactFlavor } from "@/lib/sentry/flavor-react";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

/**
 * A thin seam over the Sentry SDK so consent gating in `sentry-control.ts`
 * can dispatch through a single interface instead of importing a concrete
 * SDK directly. Each surface (browser via `@sentry/react`, iOS via
 * `@sentry/capacitor`) provides its own implementation; `selectSentryFlavor()`
 * picks the right one at runtime.
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
 * Pick the Sentry flavor for the current runtime. The `@sentry/capacitor`
 * flavor runs inside native Capacitor webviews; everything else — web and the
 * Electron renderer alike — uses the `@sentry/react` flavor. The Electron
 * renderer shares the web bundle's SDK (only its DSN differs; see
 * `resolveDsn()`), so it must use the same version-matched client our captures
 * resolve against.
 */
export function selectSentryFlavor(): SentryFlavor {
  if (isNativePlatform() && !isElectron()) return capacitorFlavor;
  return reactFlavor;
}
