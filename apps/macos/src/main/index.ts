import { app, ipcMain, net, protocol, session, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { installAbout, openAboutWindow } from "./about";
import { APP_PROTOCOL } from "./app-config";
import { resolveAppProtocolPath } from "./app-protocol";
import { installDock } from "./dock";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installApplicationMenu } from "./menu";
import { installPowerEvents } from "./power-events";
import { readSetting, writeSetting } from "./settings";
import { installTray } from "./tray";

// Dev-only: override the workspace `name` (`@vellumai/macos`) so the
// menu bar's first submenu reads "Vellum Electron", and — more
// importantly — so `app.getPath("userData")` resolves to
// `~/Library/Application Support/Vellum Electron/`, cleanly separate
// from the Swift `Vellum.app` / `Vellum Local.app` / `Vellum Dev.app`
// installs the developer may also be running.
//
// Caveat: `app.setName()` does NOT change the Dock / Cmd-Tab label.
// Those come from the running binary's `CFBundleName` — in dev the
// binary is `node_modules/electron/dist/Electron.app`, so the Dock
// says "Electron". That's cosmetic and acceptable for dev runs; the
// userData split is what actually prevents collision with Swift
// installs. Packaged builds get a real `productName` from
// electron-builder, which writes `CFBundleName`, at which point
// Dock / Cmd-Tab pick up the real name too.
//
// Gated on `!app.isPackaged` so a packaged build keeps its
// electron-builder-derived `CFBundleName` instead of being overridden
// at runtime. Must run before `app.getPath("userData")` is first read;
// the electron-store instance in `./settings` is constructed lazily on
// first IPC call, so this timing holds as long as `app.setName` runs
// before `app.whenReady`.
if (!app.isPackaged) {
  app.setName("Vellum Electron");
}
const isDev = !app.isPackaged;

// Single-instance lock: relaunches focus the existing window instead of
// spawning a parallel main process. The second-instance handler fires on the
// instance that holds the lock (the primary). The instance that fails to
// acquire calls app.quit() and never reaches whenReady.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// In prod, register `app://` as a "standard" + "secure" scheme so that fetch,
// service workers, and same-origin policy treat it like https://.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// Serve apps/web/dist/ as static files via `app://vellum.ai/...`. Route-like
// paths (no file extension, or `.html`) fall back to index.html so React
// Router can handle client-side routes on reload / deep-link; requests for
// missing static assets return 404 so a stale or partial deploy surfaces as
// a load error rather than silently serving HTML with a wrong Content-Type.
// Reference: https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler
// `apps/web/vite.config.ts` sets `base: "/assistant/"`, so the built
// HTML emits asset URLs like `/assistant/assets/index.js`. The
// renderer files on disk live directly under `rendererRoot`, NOT
// under `rendererRoot/assistant/`. Pass the mount as a separate
// parameter so the protocol handler strips it before path resolution.
const RENDERER_MOUNT = "/assistant";

const registerAppProtocol = (): void => {
  // The packaged renderer bundle lives next to the main bundle. When this app
  // is built into an .asar/Resources/app/ tree, apps/web/dist/ is copied to
  // ../renderer relative to the main process bundle.
  const rendererRoot = path.join(__dirname, "../renderer");
  const indexHtml = path.join(rendererRoot, "index.html");

  protocol.handle(APP_PROTOCOL, async (request) => {
    const result = resolveAppProtocolPath(
      rendererRoot,
      request.url,
      RENDERER_MOUNT,
    );
    if (result.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    const { resolved } = result;
    if (await fileExists(resolved)) {
      return net.fetch(pathToFileURL(resolved).toString());
    }
    const ext = path.extname(resolved);
    if (ext === "" || ext === ".html") {
      return net.fetch(pathToFileURL(indexHtml).toString());
    }
    return new Response("Not Found", { status: 404 });
  });
};

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
};

// Deny renderer permission requests by default. Specific permissions
// (microphone for voice input, notifications, etc.) are allowlisted in the
// follow-up tickets that wire each feature, so the bridge surface stays
// honest about what the app can actually do at any given commit.
const installPermissionHandler = (): void => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
};

// IPC bridge for the `window.vellum.settings.*` API exposed by preload.
// Errors from electron-store's schema validator (thrown as SyntaxError from
// `set`) propagate as rejected Promises to the renderer.
const installSettingsIpc = (): void => {
  ipcMain.handle("vellum:settings:get", (_event, key: string) => readSetting(key));
  ipcMain.handle("vellum:settings:set", (_event, key: string, value: unknown) => {
    writeSetting(key, value);
  });
};

// ---------------------------------------------------------------------------
// Daemon supervisor
// ---------------------------------------------------------------------------
//
// Spawns the bundled Bun daemon binary from Resources/bun. On exit, restarts
// with exponential backoff (1s → 2s → 4s → … capped at 30s), with the backoff
// reset to its initial value after any run that stayed up for at least
// DAEMON_STABLE_RUN_MS so a one-off crash after long uptime doesn't inherit a
// 30s wait. ENOENT during development (binary not yet bundled) is logged but
// does not retry — there is nothing to retry to.

const DAEMON_BACKOFF_INITIAL_MS = 1_000;
const DAEMON_BACKOFF_MAX_MS = 30_000;
// If the daemon ran successfully for at least this long before crashing, treat
// the crash as transient and reset the backoff to its initial value.
const DAEMON_STABLE_RUN_MS = 60_000;

let daemonProcess: ChildProcess | null = null;
let daemonBackoffMs = DAEMON_BACKOFF_INITIAL_MS;
let daemonStartedAt = 0;
let daemonRestartTimer: NodeJS.Timeout | null = null;
let daemonShuttingDown = false;
let daemonMissing = false;

const spawnDaemon = (): void => {
  if (daemonShuttingDown || daemonMissing) return;

  const binaryPath = path.join(process.resourcesPath, "bun");
  const child = spawn(binaryPath, ["daemon"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonProcess = child;
  daemonStartedAt = Date.now();

  console.log(`[daemon] spawned: ${binaryPath} (pid=${child.pid ?? "?"})`);

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[daemon] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[daemon] ${chunk.toString()}`);
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.warn(
        `[daemon] binary not found at ${binaryPath} — skipping spawn (this is expected in development).`,
      );
      daemonMissing = true;
      daemonProcess = null;
      return;
    }
    console.error("[daemon] spawn error:", err);
  });

  child.on("exit", (code, signal) => {
    const ranFor = Date.now() - daemonStartedAt;
    daemonProcess = null;
    console.warn(
      `[daemon] exited code=${code ?? "null"} signal=${signal ?? "null"} after ${ranFor}ms`,
    );
    if (daemonShuttingDown || daemonMissing) return;
    if (ranFor >= DAEMON_STABLE_RUN_MS) {
      daemonBackoffMs = DAEMON_BACKOFF_INITIAL_MS;
    }
    scheduleDaemonRestart();
  });
};

const scheduleDaemonRestart = (): void => {
  if (daemonRestartTimer) return;
  const delay = daemonBackoffMs;
  console.log(`[daemon] restarting in ${delay}ms`);
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null;
    daemonBackoffMs = Math.min(daemonBackoffMs * 2, DAEMON_BACKOFF_MAX_MS);
    spawnDaemon();
  }, delay);
};

const stopDaemon = (): void => {
  daemonShuttingDown = true;
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = null;
  }
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
  }
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// TODO(security): set a Content Security Policy via session.webRequest.
// onHeadersReceived once the prod connect-src endpoints (api.vellum.ai,
// websocket origins, telemetry) are settled in the auth + networking tickets.

app
  .whenReady()
  .then(() => {
    if (!isDev) {
      registerAppProtocol();
    }
    installPermissionHandler();
    installSettingsIpc();
    installAbout();
    installApplicationMenu();
    installDock();
    installPowerEvents();
    installTray({
      toggleMainWindow: toggleMainWindowVisibility,
      ensureMainWindow: ensureMainWindowVisible,
      openAbout: openAboutWindow,
    });
    spawnDaemon();
    installMainWindow();

    // Dock-icon click / Cmd-Tab re-activation: bring the main window
    // back to front, recreating it if it was previously closed. The
    // primitive handles both the destroyed-window and the
    // visible-but-not-focused cases, so we don't need to branch here
    // on auxiliary window counts the way the old check did.
    app.on("activate", () => {
      ensureMainWindowVisible();
    });
  })
  .catch((err: unknown) => {
    console.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", () => {
  // Behavior change vs prior code path: previously a second-instance
  // launch was a no-op when the main window had been destroyed. Now
  // we recreate so the user always sees a window in response to
  // re-launching the app.
  ensureMainWindowVisible();
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    // Only http(s) is ever opened — file:, javascript:, custom schemes are
    // denied with no fallback.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { action: "deny" };
    }

    // Programmatic popups (`window.open(url, name, features)` with size
    // hints) come through as `new-window` disposition. The web app's OAuth /
    // connect flows rely on the returned popup handle for postMessage
    // callbacks, so allow these as in-app child windows that inherit the
    // hardened webPreferences from the parent.
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            devTools: isDev,
          },
        },
      };
    }

    // Plain target=_blank link clicks → system browser.
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopDaemon();
});
