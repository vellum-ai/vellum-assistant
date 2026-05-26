import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEV_SERVER_URL = "http://localhost:5173";
const DEV_SERVER_ORIGIN = new URL(DEV_SERVER_URL).origin;
const APP_PROTOCOL = "app";
const APP_HOST = "vellum.ai";

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

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: isDev,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Same-origin allowlist for top-level navigation. Scoped to the main
  // window — popups (OAuth flows etc.) need to redirect between provider
  // domains and our callback origin, so they're left unrestricted.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    const allowed =
      (isDev && target.origin === DEV_SERVER_ORIGIN) ||
      (!isDev && target.protocol === `${APP_PROTOCOL}:` && target.host === APP_HOST);
    if (allowed) return;
    event.preventDefault();
    // External http(s) top-level navigations (e.g. `window.location.href =
    // "https://billing.stripe.com/..."`) route to the system browser instead
    // of silently failing. Other schemes stay blocked.
    if (target.protocol === "https:" || target.protocol === "http:") {
      void shell.openExternal(url);
    }
  });

  const loadTarget = isDev ? DEV_SERVER_URL : `${APP_PROTOCOL}://${APP_HOST}/index.html`;
  mainWindow.loadURL(loadTarget).catch((err: unknown) => {
    console.error(`[window] loadURL failed for ${loadTarget}:`, err);
  });
};

const focusMainWindow = (): void => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

// Serve apps/web/dist/ as static files via `app://vellum.ai/...`. Route-like
// paths (no file extension, or `.html`) fall back to index.html so React
// Router can handle client-side routes on reload / deep-link; requests for
// missing static assets return 404 so a stale or partial deploy surfaces as
// a load error rather than silently serving HTML with a wrong Content-Type.
// Reference: https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler
const registerAppProtocol = (): void => {
  // The packaged renderer bundle lives next to the main bundle. When this app
  // is built into an .asar/Resources/app/ tree, apps/web/dist/ is copied to
  // ../renderer relative to the main process bundle.
  const rendererRoot = path.join(__dirname, "../renderer");
  const rendererRootWithSep = rendererRoot + path.sep;
  const indexHtml = path.join(rendererRoot, "index.html");

  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const resolved = path.normalize(path.join(rendererRoot, relativePath));
    if (resolved !== rendererRoot && !resolved.startsWith(rendererRootWithSep)) {
      return new Response("Forbidden", { status: 403 });
    }
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
    spawnDaemon();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((err: unknown) => {
    console.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", () => {
  focusMainWindow();
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
