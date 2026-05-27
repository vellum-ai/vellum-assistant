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
export interface VellumBridge {
  platform: "electron";
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
}

const notImplemented = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`window.vellum.${name} is not implemented yet`));

const bridge: VellumBridge = {
  platform: "electron",
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
};

contextBridge.exposeInMainWorld("vellum", bridge);

declare global {
  interface Window {
    vellum: VellumBridge;
  }
}
