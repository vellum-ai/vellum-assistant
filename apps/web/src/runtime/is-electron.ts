/**
 * Minimal ambient declaration of the `window.vellum` bridge exposed by the
 * Electron preload script (see `apps/macos/src/preload/index.ts`). Surface is
 * expanded here as each follow-up ticket wires a real implementation, keeping
 * the renderer's view of the bridge honest about what's actually available
 * at any given commit.
 *
 * Feature code in `apps/web/` should NOT call `window.vellum.*` directly.
 * Instead, wrap each persisted capability in a per-feature module under
 * `apps/web/src/runtime/` with named functions (see `native-biometric.ts`
 * for the established shape: `isBiometricEnabled()` / `setBiometricEnabled()`).
 * The module owns the cross-platform branch — `isElectron()` calls into
 * `window.vellum`, `isNativePlatform()` calls Capacitor, and the web branch
 * uses `localStorage` — so consumers stay platform-agnostic.
 */
/**
 * Renderer-side mirror of the discriminated union in
 * `apps/macos/src/main/commands.ts`. Inline (rather than cross-package
 * imported) because main, preload, and renderer each have their own TS
 * project; the type is tiny enough that maintaining identical literal
 * unions is cheaper than wiring cross-package imports.
 */
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" };

declare global {
  interface Window {
    vellum?: {
      platform: "electron";
      app: {
        versionInfo(): Promise<{
          appName: string;
          version: string;
          commitSha: string;
          copyright: string;
          website: string;
        }>;
        openWebsite(): Promise<void>;
      };
      settings: {
        get<T = unknown>(key: string): Promise<T | null>;
        set<T = unknown>(key: string, value: T): Promise<void>;
      };
      commands: {
        on(callback: (command: VellumCommand) => void): () => void;
      };
      dock: {
        setBadge(count: number): Promise<void>;
        setSignedIn(signedIn: boolean): Promise<void>;
      };
      power: {
        onEvent(
          callback: (event: {
            kind: "suspend" | "resume" | "lock" | "unlock" | "active";
          }) => void,
        ): () => void;
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
