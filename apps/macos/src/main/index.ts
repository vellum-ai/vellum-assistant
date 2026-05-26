import { app, BrowserWindow, protocol, net } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEV_SERVER_URL = "http://localhost:5173";
const DEV_SERVER_ORIGIN = new URL(DEV_SERVER_URL).origin;
const APP_PROTOCOL = "app";
const APP_HOST = "vellum.ai";

const isDev = !app.isPackaged;

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
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadURL(`${APP_PROTOCOL}://${APP_HOST}/index.html`);
  }
};

// Serve apps/web/dist/ as static files via `app://vellum.ai/...`. Unknown
// non-asset paths fall back to index.html so React Router can handle
// client-side routes on reload / deep-link.
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
    const target = await firstExisting([resolved, indexHtml]);
    return net.fetch(pathToFileURL(target).toString());
  });
};

// Returns the first path that resolves to an existing file. Used to fall back
// from a missing route file (e.g. /settings) to index.html for the SPA.
const firstExisting = async (candidates: string[]): Promise<string> => {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return candidates[candidates.length - 1]!;
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

void app.whenReady().then(() => {
  if (!isDev) {
    registerAppProtocol();
  }
  spawnDaemon();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    // Compare by parsed origin / protocol+host rather than string prefix:
    // `url.startsWith("http://localhost:5173")` also matches
    // `http://localhost:5173.attacker.com/...`.
    const target = new URL(url);
    const allowed =
      (isDev && target.origin === DEV_SERVER_ORIGIN) ||
      (!isDev && target.protocol === `${APP_PROTOCOL}:` && target.host === APP_HOST);
    if (!allowed) {
      event.preventDefault();
    }
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
