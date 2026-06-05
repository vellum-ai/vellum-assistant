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
// The lockfile bridge surface is typed against the contract owned by
// `@vellumai/local-mode` (the package the Electron main produces these values
// from), so the renderer never has to re-assert the shape with casts. The
// import is type-only and erased from the renderer bundle, and resolves the
// `/contract` entry point (dependency-free types + parser) so it never pulls
// the host's Node-only I/O graph into the renderer's module resolution.
import type { Lockfile, LockfileWriteResult } from "@vellumai/local-mode/contract";

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
  | { kind: "markCurrentUnread" }
  | { kind: "openSettings" }
  | { kind: "shareFeedback" }
  | { kind: "find" }
  | { kind: "markAllRead" }
  | { kind: "logout" }
  | { kind: "rePair" }
  | { kind: "sidebarToggle" }
  | { kind: "home" }
  | { kind: "popOut" }
  | { kind: "previousConversation" }
  | { kind: "nextConversation" }
  | { kind: "commandPalette" };

/**
 * Renderer-side mirror of `AssistantStatus` in
 * `apps/macos/src/main/status.ts`. Inline for the same reason as
 * `VellumCommand` — main, preload, and renderer each have their own TS
 * project, and a tiny literal union is cheaper to mirror than to wire a
 * cross-package import. The five states map to the menu-bar status dot the
 * native app shows (`AppDelegate+MenuBar.swift`).
 */
export type AssistantStatus =
  | "idle"
  | "thinking"
  | "error"
  | "disconnected"
  | "authFailed";

/**
 * Renderer-side mirror of `ConnectivityState` in
 * `apps/macos/src/main/status.ts`. Inline for the same reason as
 * `AssistantStatus`. Main is the source of truth — it fuses device-level
 * online/offline and backend health-probe signals, then broadcasts to
 * all windows.
 */
export type ConnectivityState =
  | "online"
  | "device-offline"
  | "backend-unreachable";

export type HotkeyEventState = "down" | "up";

export interface HotkeyEvent {
  kind: "fnPushToTalk";
  state: HotkeyEventState;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

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
      csrf?: {
        getToken(): string | null;
      };
      settings: {
        get<T = unknown>(key: string): Promise<T | null>;
        set<T = unknown>(key: string, value: T): Promise<void>;
      };
      helper?: {
        hotkey?: {
          fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult>;
          onEvent(callback: (event: HotkeyEvent) => void): () => void;
        };
      };
      commands: {
        on(callback: (command: VellumCommand) => void): () => void;
      };
      // Optional: older Electron shells predate the status/icon channels. The
      // macOS app and web bundle don't release together, so a newer renderer
      // can run against an older preload; callers must guard on presence.
      status?: {
        setConnection(status: AssistantStatus): void;
      };
      icon?: {
        setAvatar(png: Uint8Array | null): void;
      };
      dock: {
        setBadge(count: number): Promise<void>;
        setSignedIn(signedIn: boolean): Promise<void>;
      };
      menu: {
        setPlatformSession(has: boolean): Promise<void>;
      };
      localMode: {
        hatch(species: string, remote?: string): Promise<{
          ok: boolean;
          assistantId?: string;
          error?: string;
        }>;
        readLockfile(): Promise<Lockfile>;
        saveLockfileAssistant(
          assistant: Record<string, unknown>,
          activeAssistant?: string,
        ): Promise<LockfileWriteResult>;
        replacePlatformAssistants(
          platformAssistants: Array<Record<string, unknown>>,
        ): Promise<LockfileWriteResult>;
        retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        // Optional: older Electron shells predate the wake IPC channel. The
        // macOS app and web bundle don't release together, so a newer renderer
        // can run against an older preload; callers must guard on its presence.
        wake?(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        guardianToken(
          assistantId: string,
        ): Promise<
          | { ok: true; accessToken: string }
          | { ok: false; status: number; error: string }
        >;
      };
      mainWindow: {
        ensureVisible(): Promise<void>;
        setOnboarding(active: boolean): Promise<void>;
        beginAuthFlow(): Promise<void>;
      };
      power: {
        onEvent(
          callback: (event: {
            kind: "suspend" | "resume" | "lock" | "unlock" | "active";
          }) => void,
        ): () => void;
      };
      deepLinks: {
        drain(): Promise<
          Array<
            | { kind: "send"; message: string }
            | { kind: "openThread"; threadId: string }
            | { kind: "unknown"; url: string }
          >
        >;
        onLink(
          callback: (
            link:
              | { kind: "send"; message: string }
              | { kind: "openThread"; threadId: string }
              | { kind: "unknown"; url: string },
          ) => void,
        ): () => void;
      };
      feedback?: {
        diagnostics(): Promise<Record<string, unknown>>;
        logs(): Promise<string>;
      };
      // Optional: older Electron shells predate the connectivity channel.
      connectivity?: {
        onState(
          callback: (state: ConnectivityState) => void,
        ): () => void;
        setDevice(online: boolean): void;
        retry(): void;
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
