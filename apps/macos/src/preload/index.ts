import { contextBridge } from "electron";

// Surface exposed to the renderer as `window.vellum`. Implementations land in
// follow-up tickets; for now these are typed stubs so the renderer can
// feature-detect the Electron host.
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
    get: notImplemented("settings.get"),
    set: notImplemented("settings.set"),
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
