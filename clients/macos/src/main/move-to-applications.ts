import { app, BrowserWindow } from "electron";

import log from "./logger";

// Build-time define (see electron.vite.config.ts) — the same VELLUM_ENVIRONMENT
// that electron-builder.config.cjs derives `productName` from.
declare const __VELLUM_ENVIRONMENT__: string;

/**
 * The app's user-facing product name ("Vellum", "Vellum Local", "Vellum Dev",
 * …). `app.getName()` can't be used here: electron-builder writes the product
 * name to the bundle Info.plist (`CFBundleName`), not into the asar'd
 * package.json, so `app.getName()` returns the package `name` (`@vellumai/macos`)
 * for packaged builds. We instead mirror the per-environment derivation in
 * electron-builder.config.cjs so the two always agree. (Setting it via
 * `app.setName()` is avoided — that would shift the production `userData` path.)
 */
function productDisplayName(): string {
  const env =
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production";
  if (env === "production") return "Vellum";
  return `Vellum ${env.charAt(0).toUpperCase()}${env.slice(1)}`;
}

/**
 * Minimal in-process splash shown while the app copies itself into
 * /Applications. `app.moveToApplicationsFolder()` is a *synchronous* call that
 * blocks the main process for the duration of the (~130 MB+) bundle copy, so we
 * can't drive a progress bar from here — but the renderer lives in its own
 * process, so the CSS animation below keeps moving while the copy is in flight.
 */
function installSplashHtml(productName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%}
    body{font-family:-apple-system,system-ui,"SF Pro Text",sans-serif;background:#fff;
      color:#1d1d1f;height:100vh;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:7px;-webkit-user-select:none;user-select:none;cursor:default}
    .t{font-size:15px;font-weight:600}
    .s{font-size:12px;color:#6e6e73}
    .bar{margin-top:16px;width:220px;height:6px;border-radius:3px;background:#ececef;
      overflow:hidden;position:relative}
    .bar::after{content:"";position:absolute;top:0;left:0;height:100%;width:40%;
      border-radius:3px;background:#4f7cff;animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{left:-40%}100%{left:100%}}
  </style></head><body>
    <div class="t">Installing ${productName}</div>
    <div class="s">Moving to Applications…</div>
    <div class="bar"></div>
  </body></html>`;
}

function createInstallSplash(): BrowserWindow {
  const name = productDisplayName();
  const win = new BrowserWindow({
    width: 340,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: "#ffffff",
    title: `Installing ${name}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(installSplashHtml(name))}`,
  );
  return win;
}

/**
 * Relocate the app into /Applications on first launch when it is running from
 * somewhere else (a mounted DMG, ~/Downloads, etc.), then relaunch from the
 * new location.
 *
 * This is the "double-click to install" half of the DMG installer flow: the
 * DMG ships a single app icon under "Install Vellum / Double click the icon
 * below" with no Applications alias, and the app installs itself here instead
 * of asking the user to drag it. It also resolves macOS app translocation —
 * an app launched from a quarantined DMG runs from a randomized read-only path
 * until it is moved into /Applications via the Finder, and
 * `moveToApplicationsFolder()` performs that move programmatically.
 *
 * The move is silent (no confirmation dialog) to match a lightweight installer
 * feel, but the multi-second bundle copy is covered by a small "Installing…"
 * splash so the gap between double-click and relaunch isn't a dead window.
 *
 * It is a no-op when:
 *  - running an unpackaged dev build, or
 *  - already in /Applications.
 *
 * Returns `true` if the app is being relocated — the caller must bail out of
 * further initialization because the process is about to quit and relaunch.
 * Returns `false` if startup should continue from the current location.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#appmovetoapplicationsfolderoptions-macos
 */
export async function relocateToApplicationsFolder(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;

  let splash: BrowserWindow | null = null;
  try {
    splash = createInstallSplash();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      splash?.once("ready-to-show", () => {
        splash?.show();
        // Let the compositor paint a frame before the synchronous move
        // freezes the main process.
        setTimeout(done, 150);
      });
      // Fallback so a missed ready-to-show can't stall startup.
      setTimeout(done, 1200);
    });
  } catch (err) {
    log.error("[move-to-applications] failed to show install splash:", err);
  }

  const closeSplash = () => {
    if (splash && !splash.isDestroyed()) splash.close();
  };

  try {
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === "existsAndRunning") {
          // Another copy is already installed and running. Leave it be and
          // keep running from the current location for this session rather
          // than nagging — the user clearly already has Vellum installed.
          log.info(
            "[move-to-applications] /Applications copy already running; skipping move",
          );
          return false;
        }
        // "exists" — a stale copy is present but not running; overwrite it.
        return true;
      },
    });
    // On success the process is already quitting/relaunching, so the splash
    // is torn down with it; only close it if we're staying put.
    if (!moved) closeSplash();
    return moved;
  } catch (err) {
    log.error("[move-to-applications] moveToApplicationsFolder failed:", err);
    closeSplash();
    return false;
  }
}
