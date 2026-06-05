import { app, net, protocol, session, shell } from "electron";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";

import {
  readAllowedGatewayPorts,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { installAbout, openAboutWindow } from "./about";
import { APP_HOST, APP_PROTOCOL } from "./app-config";
import { installCsp } from "./csp";
import { ensureWebInstalled, getWebDistPath } from "./cli-installer";
import { handle, handleSync } from "./ipc";
import { resolveAppProtocolPath } from "./app-protocol";
import { planGatewayForward } from "./gateway-forward";
import { planPlatformForward } from "./platform-forward";
import {
  extractDeepLinkFromArgv,
  handleDeepLink,
  installDeepLinks,
} from "./deep-links";
import { installAvatarIpc } from "./avatar";
import { installDock } from "./dock";
import { installFeedbackIpc } from "./feedback";
import { installGlobalShortcuts } from "./global-shortcuts";
import { installLocalMode } from "./local-mode";
import log from "./logger";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installApplicationMenu } from "./menu";
import { installConnectivityProbe } from "./connectivity-probe";
import { installPowerEvents } from "./power-events";
import { readSetting, writeSetting } from "./settings";
import { installConnectivityIpc, installStatusIpc } from "./status";
import { installTray } from "./tray";
import { hardenedWebPreferences } from "./windows";

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

// Deep-link plumbing — register at module top-level so the
// `will-finish-launching` subscription captures URLs delivered AT
// launch (the OS opens the app via a `vellum://` click → `open-url`
// can fire before `whenReady`). Registering in `whenReady` misses
// the launching URL — the #1 deep-link bug in Electron apps.
installDeepLinks();

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

const resolveRendererRoot = (): string => {
  if (app.isPackaged) {
    return getWebDistPath();
  }
  // Dev source tree: apps/web/dist — requires `bun run build` in apps/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "apps", "web", "dist");
};

const registerAppProtocol = (): void => {
  const rendererRoot = resolveRendererRoot();
  const indexHtml = path.join(rendererRoot, "index.html");
  const lockfilePaths = resolveLockfilePaths(process.env);
  const getAllowedGatewayPorts = (): Set<number> =>
    readAllowedGatewayPorts(lockfilePaths);
  const { platformUrl } = resolveLocalConfigFromEnv(process.env);

  protocol.handle(APP_PROTOCOL, async (request) => {
    // The renderer addresses local gateways at the same `app://` origin via
    // `/assistant/__gateway/{port}/*`. Forward those to loopback here so the
    // secure renderer never touches an insecure `http://127.0.0.1` origin
    // directly; the lockfile allowlist is the security boundary. Mirrors the
    // Vite dev-server proxy (`apps/web/vite-plugin-local-mode.ts`).
    const proxied = await forwardGatewayRequest(request, getAllowedGatewayPorts);
    if (proxied) return proxied;

    // Platform API routes (`/v1/*`, `/_allauth/*`, `/accounts/*`) forward to
    // the cloud platform so managed mode works in packaged builds. Mirrors the
    // Vite dev-server proxy (`apps/web/vite.config.ts` server.proxy entries).
    const platformProxied = await forwardPlatformRequest(request, platformUrl);
    if (platformProxied) return platformProxied;

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

/**
 * Forward a gateway data-plane request (`/assistant/__gateway/{port}/*`) to the
 * local gateway on loopback, or return `null` when the URL is not a gateway
 * request so the caller serves it as a static asset. `net.fetch` runs in the
 * main process, so the renderer only ever talks to its own secure `app://`
 * origin — main does the `http://127.0.0.1` hop. The streaming `Response` is
 * returned verbatim, preserving SSE and chunked transfers (Electron's
 * `stream: true` scheme privilege). `planGatewayForward` owns the allowlist and
 * header decisions; this wrapper is just the effect.
 */
const forwardGatewayRequest = async (
  request: GlobalRequest,
  getAllowedPorts: () => Set<number>,
): Promise<Response | null> => {
  const plan = planGatewayForward(request, getAllowedPorts);
  switch (plan.kind) {
    case "pass":
      return null;
    case "reject":
      return new Response(plan.message, { status: plan.status });
    case "forward":
      return net.fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.hasBody ? request.body : undefined,
        // Stream the request body instead of buffering it; required by the
        // fetch spec whenever a `ReadableStream` body is supplied.
        ...(plan.hasBody ? { duplex: "half" } : {}),
        redirect: "manual",
      });
  }
};

const CSRF_COOKIE_RE = /(?:__Secure-)?csrftoken=([^;]+)/;

// `app://` is not a cookieable scheme, so the renderer can't read the CSRF
// token via `document.cookie`. Main caches it here and injects it into
// forwarded requests; `net.fetch`'s own cookie jar supplies the cookie side.
let cachedCsrfToken: string | null = null;
handleSync("vellum:csrf:getToken", () => cachedCsrfToken);

const captureCsrfToken = (response: Response): void => {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const match = CSRF_COOKIE_RE.exec(raw);
    if (match?.[1]) {
      cachedCsrfToken = match[1];
    }
  }
};

/**
 * Forward a platform API request (`/v1/*`, `/_allauth/*`, `/accounts/*`) to
 * the cloud platform, or return `null` for non-platform paths. Mirrors the
 * gateway forward: `net.fetch` runs in main so the renderer stays same-origin.
 */
const forwardPlatformRequest = async (
  request: GlobalRequest,
  platformUrl: string,
): Promise<Response | null> => {
  const plan = planPlatformForward(request, platformUrl);
  if (plan.kind === "pass") return null;

  if (cachedCsrfToken && !plan.headers.has("X-CSRFToken")) {
    plan.headers.set("X-CSRFToken", cachedCsrfToken);
  }

  let response: Response;
  try {
    response = await net.fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.hasBody ? request.body : undefined,
      ...(plan.hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Platform unreachable";
    return new Response(message, { status: 502 });
  }

  captureCsrfToken(response);
  return response;
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
// The IPC layer only asserts the key is a string; electron-store's own
// ajv schema is the validator for both the key namespace and each
// value's shape, so the value crosses as `unknown` rather than being
// re-modeled here (a second schema would just be a drift risk).
// Validator errors (thrown as SyntaxError from `set`) propagate as
// rejected Promises to the renderer.
const installSettingsIpc = (): void => {
  handle("vellum:settings:get", z.tuple([z.string()]), ([key]) =>
    readSetting(key),
  );
  handle(
    "vellum:settings:set",
    z.tuple([z.string(), z.unknown()]),
    ([key, value]) => {
      writeSetting(key, value);
    },
  );
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(async () => {
    if (!isDev) {
      // TODO(LUM-2214): a deep-link or second-instance activation during
      // this await can create a window before the protocol handler exists.
      await ensureWebInstalled();
      registerAppProtocol();
    }
    installPermissionHandler();
    installCsp();
    installSettingsIpc();
    installLocalMode();
    installAbout();
    installFeedbackIpc();
    installApplicationMenu();
    installGlobalShortcuts();
    // Register the avatar channel before the Dock and Tray install so their
    // initial render reflects any avatar the renderer publishes during
    // bootstrap rather than briefly showing the bundled fallback mark.
    installAvatarIpc();
    installDock();
    installPowerEvents();
    // Register the status channel before the tray installs so the tray's
    // initial render reflects any status the renderer publishes during
    // bootstrap rather than briefly showing the default idle dot.
    installStatusIpc();
    const lockfilePaths = resolveLockfilePaths(process.env);
    const runProbe = installConnectivityProbe(lockfilePaths);
    installConnectivityIpc(runProbe);
    installTray({
      toggleMainWindow: toggleMainWindowVisibility,
      ensureMainWindow: ensureMainWindowVisible,
      openAbout: openAboutWindow,
    });
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
    log.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", (_event, argv) => {
  // Behavior change vs prior code path: previously a second-instance
  // launch was a no-op when the main window had been destroyed. Now
  // we recreate so the user always sees a window in response to
  // re-launching the app.
  ensureMainWindowVisible();
  // Cross-platform deep-link delivery: macOS routes second-launch
  // deep links via a fresh `open-url` on the primary instance (argv
  // is empty). Windows / Linux deliver the URL via argv and
  // `open-url` never fires. Always check argv here so the buffered
  // / broadcast pipeline is platform-agnostic.
  const deepLink = extractDeepLinkFromArgv(argv);
  if (deepLink) handleDeepLink(deepLink);
});

app.on("web-contents-created", (_event, contents) => {
  // Electron internals + our own cleanup listeners (deep-links, power-events)
  // exceed the default 10-listener cap per WebContents, triggering a spurious
  // MaxListenersExceededWarning. Bump the limit to silence it.
  contents.setMaxListeners(20);

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
      // Child popups inherit the same hardened baseline as every window. The
      // preload is intentionally omitted (these are OAuth/connect popups, not
      // Vellum-bridge surfaces), which is why `hardenedWebPreferences()`
      // leaves it out for the caller to add.
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
