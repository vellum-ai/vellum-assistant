/**
 * Minimal ambient declaration of the `window.vellum` bridge exposed by the
 * Electron preload script (see `apps/macos/src/preload/index.ts`). Surface is
 * expanded here as each follow-up ticket wires a real implementation, keeping
 * the renderer's view of the bridge honest about what's actually available
 * at any given commit.
 */
declare global {
  interface Window {
    vellum?: {
      platform: "electron";
      settings: {
        get<T = unknown>(key: string): Promise<T | null>;
        set<T = unknown>(key: string, value: T): Promise<void>;
      };
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
