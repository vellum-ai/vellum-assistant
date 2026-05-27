import { contextBridge, ipcRenderer } from "electron";

// Surface exposed to the renderer as `window.vellum`. `platform` and the
// `settings` accessors are wired through IPC; `auth` and `helper` are typed
// stubs that reject with "not implemented yet" until their feature tickets
// land. When adding new bridge methods, see the "When to extend the bridge
// with new methods" section in `apps/macos/README.md` for the convention
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
};

contextBridge.exposeInMainWorld("vellum", bridge);

declare global {
  interface Window {
    vellum: VellumBridge;
  }
}
