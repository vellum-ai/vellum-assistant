import { useSyncExternalStore } from "react";

/**
 * Minimal ambient declaration of the `window.vellum` bridge exposed by the
 * Electron preload script (see `apps/macos/src/preload/index.ts`). Only the
 * `platform` discriminator is declared here — additional bridge surfaces
 * (`auth`, `settings`, `helper`, etc.) are added in the follow-up tickets
 * that wire each feature so the renderer's view of the bridge stays honest
 * about what's actually implemented at any given commit.
 */
declare global {
  interface Window {
    vellum?: {
      platform: "electron";
    };
  }
}

/**
 * True when the renderer is running inside the Electron host. Safe to call
 * server-side / before hydration — falls through to `false` when `window`
 * isn't defined yet.
 *
 * Use this to branch behavior that differs between the web host and the
 * Electron host. For branches that differ between web and Capacitor iOS,
 * use `isNativePlatform` from `@/runtime/native-auth.js` instead.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && window.vellum?.platform === "electron";
}

/**
 * Hydration-safe hook that returns `false` on the server and during the
 * initial client render, then the live value after mount. Matches the
 * `useIsNativePlatform` pattern in `native-auth.ts` so server / client
 * reconciliation doesn't trigger a flicker.
 */
const noop = () => () => {};
export function useIsElectron(): boolean {
  return useSyncExternalStore(noop, isElectron, () => false);
}
