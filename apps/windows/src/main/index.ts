import "./env-seed";

import { app, net, protocol, shell } from "electron";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";
import { z } from "zod";

import { APP_PROTOCOL } from "./app-config";
import { resolveAppProtocolPath } from "./app-protocol";
import { handle, handleSync } from "./ipc";
import log from "./logger";
import { ensureVisible, installMainWindow } from "./main-window";
import { hardenedWebPreferences } from "./windows";

/**
 * Minimal Windows shell for the Vellum Assistant.
 *
 * This is the bootstrap skeleton: a hardened BrowserWindow loading the
 * apps/web renderer (Vite dev server in dev, `app://` static serving of
 * `resources/web-dist` in packaged builds) plus the smallest IPC surface
 * the renderer needs to boot. The renderer's runtime wrappers
 * (`apps/web/src/runtime/`) feature-detect each bridge namespace, so the
 * partial preload bridge degrades to web behavior everywhere else.
 *
 * Not ported from the macOS client yet (see `apps/macos/src/main/` for the
 * reference implementations): gateway/platform request forwarding for
 * packaged builds, native auth, deep links, tray, auto-update, CSP,
 * notifications, hotkeys, local-mode IPC, window-state persistence.
 */

// Dev-only: override the package `name` (`@vellumai/windows`) so
// `app.getPath("userData")` resolves to its own directory, cleanly separate
// from other Vellum installs (including the macOS Electron shell when
// developing this package on a Mac). Packaged builds get a real
// `productName` from electron-builder. Must run before `userData` is first
// read.
if (!app.isPackaged) {
  app.setName("Vellum Electron Windows");
}
const isDev = !app.isPackaged;

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
declare const __VELLUM_ENVIRONMENT__: string;
if (app.isPackaged) {
  const env =
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production";
  if (env !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${env}`);
  }
}

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
// Router can handle client-side routes on reload; requests for missing
// static assets return 404 so a stale or partial deploy surfaces as a load
// error rather than silently serving HTML with a wrong Content-Type.
// `apps/web/vite.config.ts` sets `base: "/assistant/"`, so the built HTML
// emits asset URLs like `/assistant/assets/index.js` while the files on disk
// live directly under `rendererRoot`; the mount prefix is stripped before
// path resolution.
//
// TODO(windows): port the gateway (`/assistant/__gateway/{port}/*`) and
// platform (`/v1/*`, `/_allauth/*`, `/accounts/*`) request forwarding from
// `apps/macos/src/main/index.ts` so packaged builds can reach local
// gateways and the cloud platform. Until then only dev runs (where the Vite
// dev server proxies both) are fully functional.
const RENDERER_MOUNT = "/assistant";

const resolveRendererRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: apps/web/dist — requires `bun run build` in apps/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "apps", "web", "dist");
};

const registerAppProtocol = (): void => {
  const rendererRoot = resolveRendererRoot();
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

// Synchronous config snapshot the preload reads at startup and exposes to the
// renderer as `window.__VELLUM_CONFIG__`. `deviceId` is null until the
// device-id store is ported from the macOS client.
const resolvedConfig = resolveLocalConfigFromEnv(process.env);
handleSync("vellum:config:get", () => ({
  webUrl: resolvedConfig.webUrl,
  platformUrl: resolvedConfig.platformUrl,
  disablePlatform:
    ["true", "1"].includes(
      (process.env.VELLUM_DISABLE_PLATFORM ?? "").toLowerCase(),
    ) || undefined,
  deviceId: null,
}));

const WEBSITE = "https://vellum.ai";

// Injected by `electron.vite.config.ts` at build time.
declare const __VELLUM_BUILD_SHA__: string;

const installAppInfoIpc = (): void => {
  handle("vellum:app:versionInfo", z.tuple([]), () => ({
    appName: app.getName(),
    version: app.getVersion(),
    commitSha:
      typeof __VELLUM_BUILD_SHA__ === "string" ? __VELLUM_BUILD_SHA__ : "unknown",
    copyright: `© ${new Date().getFullYear()} Vellum AI`,
    website: WEBSITE,
  }));

  // The renderer is sandboxed — `shell.openExternal` only works from main.
  // The target is a fixed constant, never a renderer-supplied URL, so there's
  // no open-redirect surface here.
  handle("vellum:app:openWebsite", z.tuple([]), () =>
    shell.openExternal(WEBSITE),
  );
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(() => {
    if (!isDev) {
      registerAppProtocol();
    }
    installAppInfoIpc();
    installMainWindow();
  })
  .catch((err: unknown) => {
    log.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", () => {
  // TODO(windows): deep links arrive via second-instance argv on Windows —
  // port `extractDeepLinkFromArgv` from `apps/macos/src/main/deep-links.ts`
  // when the `vellum://` protocol registration lands here.
  ensureVisible();
});

app.on("web-contents-created", (_event, contents) => {
  // Mirror renderer console output (info and up) into the main log file.
  // The packaged app has no devtools, so without this the renderer's
  // diagnostics are invisible in the field; `vellum.log` is the only
  // artifact a debugging session can read.
  contents.on("console-message", (event) => {
    if (event.level === "debug") return;
    const line = `[renderer wc=${contents.id}] ${event.message}`;
    if (event.level === "error") log.error(line);
    else if (event.level === "warning") log.warn(line);
    else log.info(line);
  });

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
    // hardened webPreferences from the parent (preload intentionally
    // omitted — these are OAuth/connect popups, not Vellum-bridge surfaces).
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: hardenedWebPreferences(),
        },
      };
    }

    // Plain target=_blank link clicks → system browser.
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

// Unlike macOS, a Windows app with no windows has no dock/menu-bar presence
// to keep it alive, so quit outright. Revisit when the tray is ported.
app.on("window-all-closed", () => {
  app.quit();
});
