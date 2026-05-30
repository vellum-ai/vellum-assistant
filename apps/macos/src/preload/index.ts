import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Command surface mirrors the discriminated union in
// `apps/macos/src/main/commands.ts`. Kept inline (rather than imported)
// because preload + main + renderer each have their own TS project; the
// type is tiny enough that maintaining three identical literal unions is
// cheaper than wiring cross-package imports. Drift surfaces as a renderer
// handler being missing for a command kind — graceful no-op, not a crash.
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" };

// Surface exposed to the renderer as `window.vellum`. `platform`, `settings`,
// and `commands` are wired through IPC; `auth` and `helper` are typed stubs
// that reject with "not implemented yet" until their feature tickets land.
// When adding new bridge methods, see the "When to extend the bridge with
// new methods" section in `apps/macos/README.md` for the convention
// (generic KV for non-sensitive prefs; dedicated `<capability>.<verb>()`
// methods for sensitive capabilities).
/**
 * Mirror of `AppVersionInfo` in `apps/macos/src/main/about.ts`. Kept inline
 * to avoid the cross-project import — the surface is small and rarely
 * changes; drift surfaces as a renderer field that's `undefined` at
 * runtime rather than a build error.
 */
export interface AppVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  copyright: string;
  website: string;
}

/**
 * Mirror of `PowerEventKind` in `apps/macos/src/main/power-events.ts`.
 * Inlined for the same reason as `VellumCommand` / `AppVersionInfo`:
 * preload + main + renderer each have their own TS project; cheaper
 * to maintain a tiny literal union three places than to wire
 * cross-project imports. Drift surfaces as a renderer handler not
 * narrowing on a new kind — graceful no-op, not a crash.
 */
export type PowerEventKind =
  | "suspend"
  | "resume"
  | "lock"
  | "unlock"
  | "active";

export interface PowerEvent {
  kind: PowerEventKind;
}

export interface VellumBridge {
  platform: "electron";
  app: {
    /**
     * Read-only metadata about the running app: name, version, commit
     * SHA (injected at build time), copyright, website. Used by the
     * branded About window. Safe to call from any window the preload
     * is attached to.
     */
    versionInfo(): Promise<AppVersionInfo>;
    /**
     * Open the marketing website in the user's default browser. The
     * renderer is sandboxed so it can't call `shell.openExternal`
     * itself; this routes through main.
     */
    openWebsite(): Promise<void>;
  };
  auth: {
    signIn(): Promise<void>;
    signOut(): Promise<void>;
    getToken(): Promise<string | null>;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    set<T = unknown>(key: string, value: T): Promise<void>;
  };
  helper: {
    ping(): Promise<"pong">;
  };
  commands: {
    /**
     * Subscribe to commands dispatched by the main-process menu / hotkey
     * system. Returns an unsubscribe function; callers should invoke it on
     * cleanup (e.g. React `useEffect` return) to avoid leaks on window
     * close or hot-reload.
     */
    on(callback: (command: VellumCommand) => void): () => void;
  };
  dock: {
    /**
     * Publish the unread count so the main process can update the macOS
     * Dock badge. Pass `0` (or any non-positive number) to clear. Main
     * formats per Swift Vellum's convention — pass-through up to 99,
     * `"99+"` beyond.
     */
    setBadge(count: number): Promise<void>;
    /**
     * Publish the user's signed-in state so the main process can decide
     * whether to keep the Dock icon visible after the last window
     * closes. Temporary — once main owns auth state directly, this
     * call becomes a no-op and the renderer drops it.
     */
    setSignedIn(signedIn: boolean): Promise<void>;
  };
  power: {
    /**
     * Subscribe to system power-state events: sleep, wake, screen
     * lock/unlock, user-did-become-active-after-idle. Returns an
     * unsubscribe function; callers should invoke it on cleanup
     * (e.g. `useEffect` return) to avoid leaks on window close or
     * hot reload.
     *
     * Long-running renderer consumers (SSE, WebSocket clients, auth
     * refresh timers) subscribe to bounce-and-reconnect on `resume`
     * / `unlock` — browser timers freeze during system suspend and
     * sockets may appear "open" but be half-dead because the remote
     * side has TCP-RST'd while we slept.
     */
    onEvent(callback: (event: PowerEvent) => void): () => void;
  };
}

const notImplemented = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`window.vellum.${name} is not implemented yet`));

const bridge: VellumBridge = {
  platform: "electron",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("vellum:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("vellum:app:openWebsite") as Promise<void>,
  },
  auth: {
    signIn: notImplemented("auth.signIn"),
    signOut: notImplemented("auth.signOut"),
    getToken: notImplemented("auth.getToken"),
  },
  settings: {
    get: <T>(key: string): Promise<T | null> =>
      ipcRenderer.invoke("vellum:settings:get", key) as Promise<T | null>,
    set: <T>(key: string, value: T): Promise<void> =>
      ipcRenderer.invoke("vellum:settings:set", key, value) as Promise<void>,
  },
  helper: {
    ping: notImplemented("helper.ping"),
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: VellumCommand) => {
        callback(command);
      };
      ipcRenderer.on("vellum:command", handler);
      return () => {
        ipcRenderer.off("vellum:command", handler);
      };
    },
  },
  dock: {
    setBadge: (count: number): Promise<void> =>
      ipcRenderer.invoke("vellum:dock:setBadge", count) as Promise<void>,
    setSignedIn: (signedIn: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:dock:setSignedIn", signedIn) as Promise<void>,
  },
  power: {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:power:event", handler);
      return () => {
        ipcRenderer.off("vellum:power:event", handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("vellum", bridge);

declare global {
  interface Window {
    vellum: VellumBridge;
  }
}
