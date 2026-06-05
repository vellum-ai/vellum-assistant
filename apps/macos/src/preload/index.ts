import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { Lockfile, LockfileWriteResult } from "@vellumai/local-mode";

// Command surface mirrors the discriminated union in
// `apps/macos/src/main/commands.ts`. Kept inline (rather than imported)
// because preload + main + renderer each have their own TS project; the
// type is tiny enough that maintaining three identical literal unions is
// cheaper than wiring cross-package imports. Drift surfaces as a renderer
// handler being missing for a command kind — graceful no-op, not a crash.
export type VellumCommand =
  | { kind: "newConversation" }
  | { kind: "currentConversation" }
  | { kind: "markCurrentUnread" }
  | { kind: "openSettings" }
  | { kind: "logout" };

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
 * Mirror of `DeepLink` in `apps/macos/src/main/deep-links.ts`. Inlined
 * (same convention as the other bridge types) — preload + main +
 * renderer each have their own TS project; cheaper to maintain a tiny
 * literal union three places than to wire cross-project imports. Drift
 * surfaces as a renderer handler not narrowing on a new kind, which
 * is a graceful no-op rather than a crash.
 */
export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | { kind: "unknown"; url: string };

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

/**
 * Mirror of `AssistantStatus` in `apps/macos/src/main/status.ts`. Inlined for
 * the same reason as the other bridge types: preload + main + renderer each
 * have their own TS project. Drift surfaces as the main-side Zod schema
 * rejecting an unknown status (the message drops silently), not a crash.
 */
export type AssistantStatus =
  | "idle"
  | "thinking"
  | "error"
  | "disconnected"
  | "authFailed";

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
  status: {
    /**
     * Publish the assistant's connection status so the main process can
     * drive the menu-bar (Tray) status dot and pulse. The renderer holds
     * the live gateway/auth connection, so it's the source of truth; main
     * owns only the presentation. Fire-and-forget — no acknowledgement.
     */
    setConnection(status: AssistantStatus): void;
  };
  icon: {
    /**
     * Publish the assistant's avatar as raw PNG bytes so the main process
     * can drive both icon surfaces — the Dock icon (`app.dock.setIcon`) and
     * the menu-bar (Tray) base image under the status dot — from one source.
     * Pass `null` when the assistant has no custom avatar so main restores
     * the bundled Vellum mark, mirroring the native app's avatar fallback.
     *
     * The renderer owns avatar identity and rasterization because Electron's
     * `nativeImage` only decodes PNG/JPEG, not the trait-composited SVG; main
     * owns per-surface masking (circular tray, rounded-rect dock).
     * Fire-and-forget — no acknowledgement.
     */
    setAvatar(png: Uint8Array | null): void;
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
  localMode: {
    /**
     * Provision a local assistant for the requested species. Main spawns the
     * Vellum CLI's `hatch` and resolves with the new assistant's id on
     * success; on failure resolves with `{ ok: false }` and an error message
     * (rather than rejecting) so the renderer renders the same error UI it
     * shows for the web/dev middleware path.
     */
    hatch(species: string, remote?: string): Promise<{
      ok: boolean;
      assistantId?: string;
      error?: string;
    }>;
    /**
     * Read the local-assistant lockfile, with sensitive fields stripped.
     * Resolves with the parsed lockfile (`{ assistants, activeAssistant }`),
     * or an empty lockfile shape when none exists yet. Rejects on a genuine
     * read/parse error so the renderer surfaces it.
     */
    readLockfile(): Promise<Lockfile>;
    /**
     * Insert or update one assistant in the lockfile and optionally set the
     * active assistant. Resolves with the updated, stripped lockfile on
     * success or `{ ok: false, error }` on a validation/write failure.
     */
    saveLockfileAssistant(
      assistant: Record<string, unknown>,
      activeAssistant?: string,
    ): Promise<LockfileWriteResult>;
    /**
     * Replace every platform (`cloud === "vellum"`) assistant in the lockfile
     * with the provided set, preserving local assistants. Resolves with the
     * updated, stripped lockfile on success or `{ ok: false, error }`.
     */
    replacePlatformAssistants(
      platformAssistants: Array<Record<string, unknown>>,
    ): Promise<LockfileWriteResult>;
    /**
     * Retire a local assistant via the Vellum CLI's `retire`. Mirrors
     * `hatch`'s never-reject contract: resolves with `{ ok: false, error }`
     * on failure rather than rejecting.
     */
    retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * Wake (start/restart) a local assistant's daemon and gateway via the
     * Vellum CLI's `wake`, re-seeding its guardian token. The non-destructive
     * repair primitive used to recover a stopped or mis-seeded assistant in
     * place. Mirrors `retire`'s never-reject contract.
     */
    wake(assistantId: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * Acquire a fresh guardian access token for a local assistant, reading
     * the token file from disk and refreshing it via the CLI when expired.
     * Authorizes the gateway token exchange.
     */
    guardianToken(
      assistantId: string,
    ): Promise<
      | { ok: true; accessToken: string }
      | { ok: false; status: number; error: string }
    >;
  };
  menu: {
    setPlatformSession(has: boolean): Promise<void>;
  };
  mainWindow: {
    /**
     * Bring the main window to the foreground: recreate if destroyed,
     * restore from minimize, show, focus. Used by feature consumers
     * reacting to inbound signals (deep links, future notification
     * clicks) that should be accompanied by the window becoming
     * user-visible. Resolves once the renderer is loaded and the
     * window is focused — same readiness gate as the main-process
     * `ensureVisible`.
     */
    ensureVisible(): Promise<void>;
    /**
     * Switch the main window between the onboarding layout (440×630
     * default) and the main-app layout. Both stay resizable. The renderer
     * calls this as the user navigates into / out of the onboarding
     * routes; main persists the mode so the next launch opens at the
     * right size.
     */
    setOnboarding(active: boolean): Promise<void>;
    /**
     * Relax the main window's same-origin navigation guard for the duration
     * of a sign-in so the OAuth provider chain (WorkOS → Google/Apple → our
     * callback) runs in-window instead of being ejected to the system
     * browser. Call right before kicking off the provider redirect; the guard
     * re-arms automatically when the flow returns to the app.
     */
    beginAuthFlow(): Promise<void>;
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
  deepLinks: {
    /**
     * Drain and return the buffer of deep links that arrived before
     * the renderer was ready. Returns ALL pending links and clears
     * the buffer. The renderer wrapper does subscribe-then-drain to
     * avoid losing a live link that arrives between `onLink`
     * subscription and `drain` completion.
     */
    drain(): Promise<DeepLink[]>;
    /**
     * Subscribe to live deep links (links arriving after the
     * renderer is up). Returns an unsubscribe function; callers
     * invoke it on cleanup. Links arriving before subscription are
     * captured by `drain`; subscribe BEFORE drain to cover the
     * narrow race where a link lands in flight.
     */
    onLink(callback: (link: DeepLink) => void): () => void;
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
  status: {
    setConnection: (status: AssistantStatus): void => {
      ipcRenderer.send("vellum:status:connection", status);
    },
  },
  icon: {
    setAvatar: (png: Uint8Array | null): void => {
      ipcRenderer.send("vellum:icon:setAvatar", png);
    },
  },
  dock: {
    setBadge: (count: number): Promise<void> =>
      ipcRenderer.invoke("vellum:dock:setBadge", count) as Promise<void>,
    setSignedIn: (signedIn: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:dock:setSignedIn", signedIn) as Promise<void>,
  },
  localMode: {
    hatch: (species: string, remote?: string) =>
      ipcRenderer.invoke("vellum:localMode:hatch", species, remote) as Promise<{
        ok: boolean;
        assistantId?: string;
        error?: string;
      }>,
    readLockfile: () =>
      ipcRenderer.invoke("vellum:localMode:readLockfile") as Promise<Lockfile>,
    saveLockfileAssistant: (
      assistant: Record<string, unknown>,
      activeAssistant?: string,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:saveLockfileAssistant",
        assistant,
        activeAssistant,
      ) as Promise<LockfileWriteResult>,
    replacePlatformAssistants: (
      platformAssistants: Array<Record<string, unknown>>,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:replacePlatformAssistants",
        platformAssistants,
      ) as Promise<LockfileWriteResult>,
    wake: (assistantId: string) =>
      ipcRenderer.invoke("vellum:localMode:wake", assistantId) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    retire: (assistantId: string) =>
      ipcRenderer.invoke("vellum:localMode:retire", assistantId) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    guardianToken: (assistantId: string) =>
      ipcRenderer.invoke(
        "vellum:localMode:guardianToken",
        assistantId,
      ) as Promise<
        | { ok: true; accessToken: string }
        | { ok: false; status: number; error: string }
      >,
  },
  menu: {
    setPlatformSession: (has: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:menu:setPlatformSession", has) as Promise<void>,
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
    beginAuthFlow: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:beginAuthFlow") as Promise<void>,
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
  deepLinks: {
    drain: (): Promise<DeepLink[]> =>
      ipcRenderer.invoke("vellum:deepLinks:drain") as Promise<DeepLink[]>,
    onLink: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: DeepLink) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:deepLinks:event", handler);
      // Tell main we're listening so it switches from "buffer" mode
      // to "broadcast only" mode. Without this, every live link
      // would also enter the buffer and be replayed on a future
      // drain (renderer reload, logout-relogin).
      ipcRenderer.send("vellum:deepLinks:subscribe");
      return () => {
        ipcRenderer.off("vellum:deepLinks:event", handler);
        ipcRenderer.send("vellum:deepLinks:unsubscribe");
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
